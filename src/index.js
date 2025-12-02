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
  return page.properties[prop]?.title?.map((t) => t.plain_text).join("") || null;
}

function getSelectName(page, prop) {
  return page.properties[prop]?.select?.name || null;
}

function getFormulaNumber(page, prop) {
  return page.properties[prop]?.formula?.number ?? null;
}

function getRelationIds(page, prop) {
  return page.properties[prop]?.relation?.map((x) => x.id) || [];
}

function getPageTitle(page) {
  const key = Object.keys(page.properties).find(
    (k) => page.properties[k].type === "title"
  );
  const t = page.properties[key]?.title;
  return t?.map((x) => x.plain_text).join("") || null;
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
// CLONE CHILD DATABASE FROM TEMPLATE ONLY
// ---------------------------------------------------------
async function createProjectsDbFromTemplate(managerPageId) {
  console.log("📦 Creating Projects DB…");

  // 1) جيب بلوكات التيمبليت
  const blocks = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
    page_size: 100,
  });

  // 2) لاقي داتابيس "مشاريعك"
  const dbBlock = blocks.results.find(
    (b) => b.type === "child_database" && b.child_database?.title === "مشاريعك"
  );

  if (!dbBlock) throw new Error("❌ Template has no 'مشاريعك' database.");

  // 3) جيب السكيمة الأصلية
  const templateDb = await notion.databases.retrieve({
    database_id: dbBlock.id,
  });

  // 4) أنشئ نسخة جديدة داخل صفحة المدير
  const newDb = await notion.databases.create({
    parent: { page_id: managerPageId },
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: templateDb.properties,
  });

  console.log("✅ Projects DB Created:", newDb.id);
  return newDb.id;
}

// ---------------------------------------------------------
// ENSURE DB EXISTS
// ---------------------------------------------------------
async function ensureProjectsDatabase(managerPageId) {
  let cursor;

  while (true) {
    const res = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      if (
        block.type === "child_database" &&
        block.child_database?.title === "مشاريعك"
      ) {
        return block.id;
      }
    }

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  // إذا مو موجود → انسخه من التيمبليت
  return await createProjectsDbFromTemplate(managerPageId);
}

// ---------------------------------------------------------
// MANAGER CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManagerTarget(relId, stats) {
  const original = await notion.pages.retrieve({ page_id: relId });
  const managerName = getPageTitle(original);

  if (!managerName) throw new Error("No manager name");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

  // Search for manager page
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
    // إنشاء صفحة مدير جديدة
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

  // تأكد من وجود "مشاريعك"
  const projectsDbId = await ensureProjectsDatabase(managerPageId);

  const cacheObj = { managerPageId, projectsDbId, managerName };
  managersCache.set(managerName, cacheObj);
  return cacheObj;
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
  // Search existing
  const existing = await notion.databases.query({
    database_id: managerProjectsDbId,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
  });

  const props = {
    "اسم المشروع": { title: [{ text: { content: projectName } }] },
  };

  // خصائص إضافية إذا موجودة بالداتابيس
  const schema = await notion.databases.retrieve({
    database_id: managerProjectsDbId,
  });

  if (schema.properties["حالة المشروع"] && projectStatus) {
    props["حالة المشروع"] = { select: { name: projectStatus } };
  }

  if (schema.properties["المبلغ المتبقي"] && remainingAmount !== null) {
    props["المبلغ المتبقي"] = { number: remainingAmount };
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
      console.error("Manager Error:", e.message);
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
      console.error("Project Error:", e.message);
    }
  }

  console.log("=== STATS ===");
  console.log(stats);
}

main();
