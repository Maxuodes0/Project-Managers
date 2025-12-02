// src/index.js
import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// ---------------------------------------------------------
// ENV
// ---------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROJECTS_DB = process.env.PROJECTS_DB;
const MANAGERS_DB = process.env.MANAGERS_DB;
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID;

function validateEnv() {
  const req = { NOTION_TOKEN, PROJECTS_DB, MANAGERS_DB, TEMPLATE_PAGE_ID };
  const missing = Object.entries(req)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    console.error("❌ Missing ENV:", missing.join(", "));
    process.exit(1);
  }
}
validateEnv();

const notion = new Client({ auth: NOTION_TOKEN });

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
const getTitle = (page, prop) =>
  page.properties[prop]?.title?.map((t) => t.plain_text).join("") || null;

const getSelect = (page, prop) =>
  page.properties[prop]?.select?.name || null;

const getNumber = (page, prop) =>
  page.properties[prop]?.formula?.number ?? null;

const getRelations = (page, prop) =>
  page.properties[prop]?.relation?.map((x) => x.id) || [];

function getPageTitle(pg) {
  const key = Object.keys(pg.properties).find(
    (k) => pg.properties[k].type === "title"
  );
  const t = pg.properties[key]?.title;
  return t?.map((x) => x.plain_text).join("") || null;
}

// ---------------------------------------------------------
// FETCH PROJECTS
// ---------------------------------------------------------
async function fetchAllProjects(table) {
  const pages = [];
  let cursor;
  while (true) {
    const r = await notion.databases.query({
      database_id: table,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...r.results);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  return pages;
}

// ---------------------------------------------------------
// CREATE INLINE DATABASE FROM TEMPLATE DB
// ---------------------------------------------------------
async function createInlineProjectsDB(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…");

  // 1) Read the template page children
  const tBlocks = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
    page_size: 100,
  });

  const templateDbBlock = tBlocks.results.find(
    (b) => b.type === "child_database" && b.child_database?.title === "مشاريعك"
  );

  if (!templateDbBlock) throw new Error("❌ Template missing 'مشاريعك' DB.");

  // 2) Read template DB schema
  const templateDb = await notion.databases.retrieve({
    database_id: templateDbBlock.id,
  });

  // 3) Create INLINE DB
  const newDb = await notion.databases.create({
    parent: {
      type: "page_id",
      page_id: managerPageId,
    },
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: templateDb.properties, // full schema copy
  });

  console.log("✅ INLINE DB CREATED:", newDb.id);
  return newDb.id;
}

// ---------------------------------------------------------
// ENSURE INLINE DB EXISTS IN PAGE
// ---------------------------------------------------------
async function ensureProjectsDB(managerPageId) {
  let cursor;
  while (true) {
    const res = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      if (block.type === "child_database" && block.child_database?.title === "مشاريعك") {
        return block.id; // found inline db
      }
    }

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  return await createInlineProjectsDB(managerPageId);
}

// ---------------------------------------------------------
// MANAGERS CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManager(relPageId, stats) {
  const original = await notion.pages.retrieve({ page_id: relPageId });
  const managerName = getPageTitle(original);

  if (!managerName) throw new Error("No manager name");

  // check cache
  if (managersCache.has(managerName)) {
    return managersCache.get(managerName);
  }

  // search in MANAGERS_DB
  const found = await notion.databases.query({
    database_id: MANAGERS_DB,
    filter: {
      property: "اسم مدير المشروع",
      title: { equals: managerName },
    },
  });

  let managerPageId;

  if (found.results.length) {
    managerPageId = found.results[0].id;
  } else {
    const created = await notion.pages.create({
      parent: { database_id: MANAGERS_DB },
      properties: {
        "اسم مدير المشروع": {
          title: [{ text: { content: managerName } }],
        },
      },
    });

    managerPageId = createPageId = created.id;
    stats.newManagerPages++;
  }

  // ensure inline DB exists
  const projectsDbId = await ensureProjectsDB(managerPageId);

  const obj = { managerName, managerPageId, projectsDbId };
  managersCache.set(managerName, obj);
  return obj;
}

// ---------------------------------------------------------
// UPSERT PROJECT
// ---------------------------------------------------------
async function upsertProject({
  managerProjectsDbId,
  projectName,
  projectStatus,
  remaining,
  stats,
}) {
  const existing = await notion.databases.query({
    database_id: managerProjectsDbId,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
  });

  const payload = {
    "اسم المشروع": {
      title: [{ text: { content: projectName } }],
    },
  };

  // check schema before adding
  const schema = await notion.databases.retrieve({
    database_id: managerProjectsDbId,
  });

  if (schema.properties["حالة المشروع"] && projectStatus) {
    payload["حالة المشروع"] = { select: { name: projectStatus } };
  }

  if (schema.properties["المبلغ المتبقي"] && remaining !== null) {
    payload["المبلغ المتبقي"] = { number: remaining };
  }

  if (existing.results.length) {
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: payload,
    });
    stats.projectsUpdated++;
  } else {
    await notion.pages.create({
      parent: { database_id: managerProjectsDbId },
      properties: payload,
    });
    stats.projectsInserted++;
  }
}

// ---------------------------------------------------------
// PROCESS PROJECT
// ---------------------------------------------------------
async function processProject(project, stats) {
  stats.totalProjects++;

  const name = getTitle(project, "اسم المشروع");
  const status = getSelect(project, "حالة المشروع");
  const remaining = getNumber(project, "المبلغ المتبقي");
  const relManagers = getRelations(project, "مدير المشروع");

  if (!name || !relManagers.length) return;

  for (const m of relManagers) {
    try {
      const { projectsDbId } = await getOrCreateManager(m, stats);

      await upsertProject({
        managerProjectsDbId: projectsDbId,
        projectName: name,
        projectStatus: status,
        remaining,
        stats,
      });
    } catch (err) {
      console.error("Manager error:", err.message);
    }
  }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
  const stats = {
    totalProjects: 0,
    projectsInserted: 0,
    projectsUpdated: 0,
    newManagerPages: 0,
  };

  const projects = await fetchAllProjects(PROJECTS_DB);

  for (const project of projects) {
    try {
      await processProject(project, stats);
    } catch (err) {
      console.error("Project error:", err.message);
    }
  }

  console.log("=== STATS ===");
  console.log(stats);
}

main();
