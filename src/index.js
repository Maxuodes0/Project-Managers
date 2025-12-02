// src/index.js
import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// ---------------------------------------------------------
// ENV VALIDATION
// ---------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROJECTS_DB = process.env.PROJECTS_DB;
const MANAGERS_DB = process.env.MANAGERS_DB;
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID;

function validateEnv() {
  const req = {
    NOTION_TOKEN,
    PROJECTS_DB,
    MANAGERS_DB,
    TEMPLATE_PAGE_ID,
  };
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
function getPageTitle(page) {
  const key = Object.keys(page.properties).find(
    (k) => page.properties[k].type === "title"
  );
  if (!key) return null;
  const t = page.properties[key].title;
  return t?.map((x) => x.plain_text).join("") || null;
}

function getTitle(page, prop) {
  const p = page.properties[prop];
  return p?.title?.map((x) => x.plain_text).join("") || null;
}

function getSelectName(page, prop) {
  const x = page.properties[prop];
  return x?.select?.name || null;
}

function getFormulaNumber(page, prop) {
  const f = page.properties[prop];
  return f?.formula?.number ?? null;
}

function getRelationIds(page, prop) {
  const r = page.properties[prop];
  return r?.relation?.map((x) => x.id) || [];
}

// ---------------------------------------------------------
// CLEAN DB SCHEMA  (important patch)
// ---------------------------------------------------------
function cleanDatabaseProperties(props) {
  const clean = {};
  for (const [k, val] of Object.entries(props)) {
    const t = val.type;
    if (t === "formula" || t === "rollup") continue; // ❌ Not allowed
    clean[k] = val;
  }
  return clean;
}

// ---------------------------------------------------------
// FETCH PROJECTS
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
// COPY TEMPLATE — FIXED VERSION
// ---------------------------------------------------------
async function copyTemplateToManagerPage(managerPageId) {
  console.log(`📦 Copying template → ${managerPageId}`);

  let cursor;

  while (true) {
    const res = await notion.blocks.children.list({
      block_id: TEMPLATE_PAGE_ID,
      page_size: 100,
      start_cursor: cursor,
    });

    let batch = [];

    const flush = async () => {
      if (batch.length === 0) return;
      await notion.blocks.children.append({
        block_id: managerPageId,
        children: batch,
      });
      batch = [];
    };

    for (const block of res.results) {
      if (block.type === "child_database") {
        await flush();

        const templateDb = await notion.databases.retrieve({
          database_id: block.id,
        });

        await notion.databases.create({
          parent: { page_id: managerPageId },
          title: templateDb.title,
          properties: cleanDatabaseProperties(templateDb.properties),
        });
      } else {
        const { type, has_children } = block;
        batch.push({
          type,
          has_children,
          [type]: block[type],
        });
      }
    }

    await flush();

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  console.log(`✅ Template copied to ${managerPageId}`);
}

// ---------------------------------------------------------
// FIND CHILD DB "مشاريعك"
// ---------------------------------------------------------
async function findProjectsChildDatabase(managerPageId) {
  let cursor;

  while (true) {
    const r = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const b of r.results) {
      if (
        b.type === "child_database" &&
        b.child_database?.title === "مشاريعك"
      ) {
        return b.id;
      }
    }

    if (!r.has_more) break;
    cursor = r.next_cursor;
  }

  return null;
}

async function ensureProjectsDatabase(managerPageId) {
  let dbId = await findProjectsChildDatabase(managerPageId);
  if (dbId) return dbId;

  await copyTemplateToManagerPage(managerPageId);

  dbId = await findProjectsChildDatabase(managerPageId);
  if (!dbId) {
    console.error("❌ مشاريعك DB STILL MISSING:", managerPageId);
    return null;
  }
  return dbId;
}

// ---------------------------------------------------------
// MANAGER CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManagerTarget(relId, stats) {
  const original = await notion.pages.retrieve({ page_id: relId });
  const managerName = getPageTitle(original);

  if (!managerName) throw new Error("لا يوجد اسم مدير");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

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

    managerPageId = created.id;
    stats.newManagerPages++;
    await copyTemplateToManagerPage(managerPageId);
  }

  const projectsDbId = await ensureProjectsDatabase(managerPageId);
  if (!projectsDbId)
    throw new Error(`Missing مشاريعك DB for ${managerName}`);

  const payload = { managerPageId, projectsDbId, managerName };
  managersCache.set(managerName, payload);
  return payload;
}

// ---------------------------------------------------------
// UPSERT PROJECT
// ---------------------------------------------------------
async function upsertProjectForManager({
  managerProjectsDbId,
  projectName,
  projectStatus,
  remainingAmount,
  stats,
}) {
  const exists = await notion.databases.query({
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

  if (projectStatus)
    props["حالة المشروع"] = { select: { name: projectStatus } };

  if (remainingAmount !== null)
    props["المبلغ المتبقي"] = { number: remainingAmount };

  if (exists.results.length) {
    await notion.pages.update({
      page_id: exists.results[0].id,
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
async function processProjectPage(project, stats) {
  stats.totalProjectsProcessed++;

  const projectName = getTitle(project, "اسم المشروع");
  const projectStatus = getSelectName(project, "حالة المشروع");
  const remainingAmount = getFormulaNumber(project, "المبلغ المتبقي");
  const managers = getRelationIds(project, "مدير المشروع");

  if (!projectName || managers.length === 0) return;

  for (const m of managers) {
    try {
      const { projectsDbId } = await getOrCreateManagerTarget(m, stats);

      await upsertProjectForManager({
        managerProjectsDbId: projectsDbId,
        projectName,
        projectStatus,
        remainingAmount,
        stats,
      });
    } catch (e) {
      console.error("Error manager:", e.message);
      continue;
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
