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
const HR_DB = process.env.HR_DB;

function validateEnv() {
  const req = { NOTION_TOKEN, PROJECTS_DB, MANAGERS_DB, HR_DB };
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
// CREATE INLINE PROJECTS DB (CUSTOM SCHEMA)
// ---------------------------------------------------------
async function createInlineProjectsDB(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…");

  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: managerPageId },
    title: [{ type: "text", text: { content: "مشاريعك" } }],
    is_inline: true,
    properties: {
      "اسم المشروع": {
        title: {},
      },
      "حالة المشروع": {
        select: {
          options: [
            { name: "جاري التنفيذ", color: "blue" },
            { name: "مكتمل", color: "green" },
            { name: "متاخر", color: "red" },
            { name: "طلب تعديل", color: "yellow" },
          ],
        },
      },
      "المبلغ المتبقي": {
        number: {
          format: "number",
        },
      },
    },
  });

  console.log("✅ INLINE DB CREATED:", db.id);
  return db.id;
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

  if (!managerName) throw new Error("Manager name missing");

  if (managersCache.has(managerName)) {
    return managersCache.get(managerName);
  }

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

  const projectsDbId = await ensureProjectsDB(managerPageId);

  const obj = { managerPageId, projectsDbId };
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

  if (projectStatus) {
    props["حالة المشروع"] = { select: { name: projectStatus } };
  }

  if (remaining !== null) {
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

  console.log("🚀 STARTING NOTION SYNC");

  const projects = await fetchAllProjects(PROJECTS_DB);

  for (const p of projects) {
    try {
      await processProject(p, stats);
    } catch (err) {
      console.error("Project error:", err.message);
    }
  }

  console.log("✅ DONE");
  console.log(stats);
}

main();
