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
const getTitle = (page, p) =>
  page.properties[p]?.title?.map((t) => t.plain_text).join("") || null;

const getSelect = (page, p) => page.properties[p]?.select?.name || null;

const getNumber = (page, p) =>
  page.properties[p]?.formula?.number ?? null;

const getRelations = (page, p) =>
  page.properties[p]?.relation?.map((x) => x.id) || [];

const getPageTitle = (pg) => {
  const key = Object.keys(pg.properties).find(
    (k) => pg.properties[k].type === "title"
  );
  return pg.properties[key]?.title
    ?.map((t) => t.plain_text)
    .join("") || null;
};

// ---------------------------------------------------------
// FETCH ALL PROJECTS
// ---------------------------------------------------------
async function fetchAllProjectsFromDatabase(db) {
  const pages = [];
  let cursor;
  while (true) {
    const r = await notion.databases.query({
      database_id: db,
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
// CREATE INLINE DATABASE FROM TEMPLATE
// ---------------------------------------------------------
async function createProjectsDbFromTemplate(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…");

  // 1) Fetch template children
  const blocks = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
    page_size: 100,
  });

  // 2) Find child_database "مشاريعك"
  const dbBlock = blocks.results.find(
    (b) => b.type === "child_database" && b.child_database?.title === "مشاريعك"
  );
  if (!dbBlock) throw new Error("❌ Template missing 'مشاريعك' DB.");

  // 3) Get original schema
  const templateDb = await notion.databases.retrieve({
    database_id: dbBlock.id,
  });

  // 4) Create INLINE child_database block
  const appended = await notion.blocks.children.append({
    block_id: managerPageId,
    children: [
      {
        type: "child_database",
        child_database: { title: "مشاريعك" },
      },
    ],
  });

  const newDbId = appended.results[0].id;

  // 5) Apply template schema
  await notion.databases.update({
    database_id: newDbId,
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: templateDb.properties,
  });

  console.log("✅ INLINE DB Created:", newDbId);
  return newDbId;
}

// ---------------------------------------------------------
// ENSURE "مشاريعك" DB EXISTS
// ---------------------------------------------------------
async function ensureProjectsDatabase(managerPageId) {
  let cursor;
  while (true) {
    const res = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const b of res.results) {
      if (
        b.type === "child_database" &&
        b.child_database?.title === "مشاريعك"
      ) {
        return b.id;
      }
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  // If not found → create new inline one
  return createProjectsDbFromTemplate(managerPageId);
}

// ---------------------------------------------------------
// MANAGERS CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManagerTarget(relId, stats) {
  const original = await notion.pages.retrieve({ page_id: relId });
  const managerName = getPageTitle(original);
  if (!managerName) throw new Error("Missing manager name");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

  // Search for existing manager page
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
    managerPageId = created.id;
    stats.newManagerPages++;
  }

  const projectsDbId = await ensureProjectsDatabase(managerPageId);

  const cache = { managerPageId, projectsDbId, managerName };
  managersCache.set(managerName, cache);
  return cache;
}

// ---------------------------------------------------------
// UPSERT PROJECT INTO MANAGER DB
// ---------------------------------------------------------
async function upsertProjectForManager({
  managerProjectsDbId,
  projectName,
  projectStatus,
  remainingAmount,
  stats,
}) {
  // Check if exists
  const existing = await notion.databases.query({
    database_id: managerProjectsDbId,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
  });

  const payload = {
    "اسم المشروع": { title: [{ text: { content: projectName } }] },
  };

  // Fetch schema
  const schema = await notion.databases.retrieve({
    database_id: managerProjectsDbId,
  });

  if (schema.properties["حالة المشروع"] && projectStatus) {
    payload["حالة المشروع"] = { select: { name: projectStatus } };
  }

  if (schema.properties["المبلغ المتبقي"] && remainingAmount !== null) {
    payload["المبلغ المتبقي"] = { number: remainingAmount };
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
async function processProjectPage(project, stats) {
  stats.totalProjectsProcessed++;

  const projectName = getTitle(project, "اسم المشروع");
  const projectStatus = getSelect(project, "حالة المشروع");
  const remainingAmount = getNumber(project, "المبلغ المتبقي");
  const managers = getRelations(project, "مدير المشروع");

  if (!projectName || managers.length === 0) return;

  for (const managerId of managers) {
    try {
      const { projectsDbId } = await getOrCreateManagerTarget(
        managerId,
        stats
      );

      await upsertProjectForManager({
        managerProjectsDbId: projectsDbId,
        projectName,
        projectStatus,
        remainingAmount,
        stats,
      });
    } catch (e) {
      console.error("Manager error:", e.message);
    }
  }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
  const stats = {
    totalProjectsProcessed: 0,
    projectsInserted: 0,
    projectsUpdated: 0,
    newManagerPages: 0,
  };

  const projects = await fetchAllProjectsFromDatabase(PROJECTS_DB);

  for (const project of projects) {
    try {
      await processProjectPage(project, stats);
    } catch (e) {
      console.error("Project error:", e.message);
    }
  }

  console.log("=== STATS ===");
  console.log(stats);
}

main();
