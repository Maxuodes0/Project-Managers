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
function getTitle(page, prop) {
  return page.properties[prop]?.title?.map(t => t.plain_text).join("") || null;
}
function getSelect(page, prop) {
  return page.properties[prop]?.select?.name || null;
}
function getFormulaNumber(page, prop) {
  return page.properties[prop]?.formula?.number ?? null;
}
function getRelations(page, prop) {
  return page.properties[prop]?.relation?.map(r => r.id) || [];
}
function getPageTitle(pg) {
  const key = Object.keys(pg.properties).find(
    k => pg.properties[k].type === "title"
  );
  return pg.properties[key]?.title?.map(t => t.plain_text).join("") || null;
}

// ---------------------------------------------------------
// CLEAN PROPERTIES (remove formula + rollup)
// ---------------------------------------------------------
function cleanProperties(props) {
  const clean = {};
  for (const [key, val] of Object.entries(props)) {
    if (val.type === "formula") continue;
    if (val.type === "rollup") continue;
    clean[key] = val;
  }
  return clean;
}

// ---------------------------------------------------------
// FETCH ALL PROJECTS
// ---------------------------------------------------------
async function fetchAllProjects(db) {
  const res = [];
  let cursor;

  while (true) {
    const r = await notion.databases.query({
      database_id: db,
      page_size: 100,
      start_cursor: cursor,
    });

    res.push(...r.results);

    if (!r.has_more) break;
    cursor = r.next_cursor;
  }

  return res;
}

// ---------------------------------------------------------
// CREATE INLINE PROJECT DB
// ---------------------------------------------------------
async function createInlineProjectsDB(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…");

  // get template children
  const blocks = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
    page_size: 100,
  });

  const templateBlock = blocks.results.find(
    b => b.type === "child_database" && b.child_database?.title === "مشاريعك"
  );

  if (!templateBlock) throw new Error("❌ Template missing مشاريعك DB");

  const templateDB = await notion.databases.retrieve({
    database_id: templateBlock.id,
  });

  const cleanProps = cleanProperties(templateDB.properties);

  const newDb = await notion.databases.create({
    parent: { type: "page_id", page_id: managerPageId },
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: cleanProps,
  });

  console.log("✅ INLINE DB CREATED:", newDb.id);

  return newDb.id;
}

// ---------------------------------------------------------
// ENSURE INLINE DB EXISTS
// ---------------------------------------------------------
async function ensureProjectsDB(managerPageId) {
  let cursor;

  while (true) {
    const r = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const b of r.results) {
      if (b.type === "child_database" && b.child_database?.title === "مشاريعك") {
        return b.id;
      }
    }

    if (!r.has_more) break;
    cursor = r.next_cursor;
  }

  return await createInlineProjectsDB(managerPageId);
}

// ---------------------------------------------------------
// MANAGER CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManager(relId, stats) {
  const original = await notion.pages.retrieve({ page_id: relId });
  const managerName = getPageTitle(original);

  if (!managerName) throw new Error("No manager name");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

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

    managerPageId = created.id;  // <-- FIXED
    stats.newManagerPages++;
  }

  const projectsDbId = await ensureProjectsDB(managerPageId);

  const obj = { managerPageId, managerName, projectsDbId };
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

  const props = {
    "اسم المشروع": {
      title: [{ text: { content: projectName } }],
    },
  };

  const schema = await notion.databases.retrieve({
    database_id: managerProjectsDbId,
  });

  if (schema.properties["حالة المشروع"] && projectStatus) {
    props["حالة المشروع"] = { select: { name: projectStatus } };
  }

  if (schema.properties["المبلغ المتبقي"] && remaining !== null) {
    props["المبلغ المتبقي"] = { number: remaining };
  }

  if (existing.results.length) {
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props,
    });
    stats.projectsUpdated++;
  } else {
    await notion.pages.create({
      parent: { database_id: managerProjectsDbId },
      properties: props,
    });
    stats.projectsInserted++;
  }
}

// ---------------------------------------------------------
// PROCESS PROJECT
// ---------------------------------------------------------
async function processProject(page, stats) {
  stats.total++;

  const name = getTitle(page, "اسم المشروع");
  if (!name) return;

  const status = getSelect(page, "حالة المشروع");
  const remaining = getFormulaNumber(page, "المبلغ المتبقي");
  const managers = getRelations(page, "مدير المشروع");

  if (!managers.length) return;

  for (const m of managers) {
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
    total: 0,
    projectsInserted: 0,
    projectsUpdated: 0,
    newManagerPages: 0,
  };

  const projects = await fetchAllProjects(PROJECTS_DB);

  for (const p of projects) {
    try {
      await processProject(p, stats);
    } catch (err) {
      console.error("Project error:", err.message);
    }
  }

  console.log("=== STATS ===");
  console.log(stats);
}

main();
