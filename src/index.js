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
const HR_DB = process.env.HR_DB;

function validateEnv() {
  const req = { NOTION_TOKEN, PROJECTS_DB, MANAGERS_DB, TEMPLATE_PAGE_ID, HR_DB };
  const missing = Object.entries(req).filter(([k, v]) => !v).map(([k]) => k);

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
// COPY TEMPLATE BLOCKS INTO MANAGER PAGE
// ---------------------------------------------------------
async function copyTemplateBlocks(templatePageId, managerPageId) {
  console.log("📦 Copying template blocks...");

  let cursor;
  let blocks = [];

  // سحب جميع البلوكات
  while (true) {
    const res = await notion.blocks.children.list({
      block_id: templatePageId,
      page_size: 100,
      start_cursor: cursor,
    });

    blocks.push(...res.results);

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  // نسخ البلوكات للصفحة الجديدة
  for (const block of blocks) {
    const cleanBlock = JSON.parse(JSON.stringify(block));
    delete cleanBlock.id;
    delete cleanBlock.created_time;
    delete cleanBlock.last_edited_time;

    try {
      await notion.blocks.children.append({
        block_id: managerPageId,
        children: [cleanBlock],
      });

    } catch (err) {
      console.log(`⚠️ Failed copying block ${block.type}:`, err.message);
    }
  }

  console.log("✅ Template copied successfully!");
}

// ---------------------------------------------------------
// FIND INLINE DB "مشاريعك"
// ---------------------------------------------------------
async function findInlineProjectsDB(managerPageId) {
  let cursor;
  while (true) {
    const r = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const b of r.results) {
      if (b.type === "child_database" && b.child_database?.title === "مشاريعك") {
        console.log("✅ Found inline المشاريع DB:", b.id);
        return b.id;
      }
    }

    if (!r.has_more) break;
    cursor = r.next_cursor;
  }

  return null;
}

// ---------------------------------------------------------
// FETCH MANAGER IMAGE FROM HR DB
// ---------------------------------------------------------
async function getManagerFileObject(managerName) {
  console.log(`🔍 Searching HR for image of: ${managerName}`);

  const result = await notion.databases.query({
    database_id: HR_DB,
    filter: {
      property: "اسم الموظف",
      title: { equals: managerName }
    },
    page_size: 1
  });

  if (!result.results.length) {
    console.log("⚠️ No HR record found for", managerName);
    return null;
  }

  const page = result.results[0];
  const files = page.properties["الصورة الشخصية للموظف"]?.files;

  if (!files || !files.length) {
    console.log("⚠️ HR record exists but has no image");
    return null;
  }

  const file = files[0];
  return file.type === "file"
    ? {
        name: file.name,
        file: { url: file.file.url, expiry_time: file.file.expiry_time }
      }
    : {
        name: file.name,
        external: { url: file.external.url }
      };
}

// ---------------------------------------------------------
// MANAGER CACHE
// ---------------------------------------------------------
const managersCache = new Map();

async function getOrCreateManager(managerRelationId, stats) {
  const originalPage = await notion.pages.retrieve({ page_id: managerRelationId });
  const managerName = getPageTitle(originalPage);

  console.log("\n=================================");
  console.log(`👤 Processing manager: ${managerName}`);
  console.log("=================================");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

  // Fetch HR image
  const imageObj = await getManagerFileObject(managerName);
  const imageProps = imageObj
    ? { "الصورة الشخصية للموظف": { files: [imageObj] } }
    : {};

  // Check if manager page exists
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
    console.log("📄 Existing manager page:", managerPageId);

    // Update image if exists
    if (Object.keys(imageProps).length) {
      await notion.pages.update({
        page_id: managerPageId,
        properties: imageProps,
      });
      console.log("🖼 Updated image");
    }

  } else {
    // Create manager page
    const created = await notion.pages.create({
      parent: { database_id: MANAGERS_DB },
      properties: {
        "اسم مدير المشروع": {
          title: [{ text: { content: managerName } }],
        },
        ...imageProps
      },
    });

    managerPageId = created.id;
    stats.newManagerPages++;
    console.log("🆕 Created manager page:", managerPageId);

    // Copy template into manager page
    await copyTemplateBlocks(TEMPLATE_PAGE_ID, managerPageId);
  }

  // Ensure inline DB exists
  const projectsDbId = await findInlineProjectsDB(managerPageId);

  if (!projectsDbId) {
    throw new Error("❌ Inline DB 'مشاريعك' not found after template copy!");
  }

  const obj = { managerPageId, managerName, projectsDbId };
  managersCache.set(managerName, obj);
  return obj;
}

// ---------------------------------------------------------
// UPSERT PROJECT
// ---------------------------------------------------------
async function upsertProject({ managerProjectsDbId, projectName, projectStatus, remaining, stats }) {
  console.log(`🔄 UPSERT project "${projectName}" into DB ${managerProjectsDbId}`);

  const existing = await notion.databases.query({
    database_id: managerProjectsDbId,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName }
    },
  });

  const props = {
    "اسم المشروع": { title: [{ text: { content: projectName } }] },
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
// PROCESS EACH PROJECT
// ---------------------------------------------------------
async function processProject(page, stats) {
  stats.total++;

  const name = getTitle(page, "اسم المشروع");
  const status = getSelect(page, "حالة المشروع");
  const remaining = getFormulaNumber(page, "المبلغ المتبقي");
  const managers = getRelations(page, "مدير المشروع");

  if (!name || !managers.length) return;

  console.log(`\n📂 Project: ${name}`);

  for (const managerId of managers) {
    const { projectsDbId } = await getOrCreateManager(managerId, stats);
    await upsertProject({
      managerProjectsDbId: projectsDbId,
      projectName: name,
      projectStatus: status,
      remaining,
      stats
    });
  }
}

// ---------------------------------------------------------
// MAIN RUNNER
// ---------------------------------------------------------
async function main() {
  const stats = {
    total: 0,
    projectsInserted: 0,
    projectsUpdated: 0,
    newManagerPages: 0
  };

  const projects = await notion.databases.query({
    database_id: PROJECTS_DB,
    page_size: 100
  });

  for (const p of projects.results) {
    await processProject(p, stats);
  }

  console.log("\n=== STATS ===");
  console.log(stats);
}

main();
