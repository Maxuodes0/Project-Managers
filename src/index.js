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
  const missing = Object.entries(req).filter(([, v]) => !v).map(([k]) => k);
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
// FETCH IMAGE OBJECT FROM HR DB (دالة جديدة/معدلة)
// ---------------------------------------------------------
async function getManagerFileObject(managerName) {
  console.log(`🔍 Searching HR for image of: ${managerName}`);

  const result = await notion.databases.query({
    database_id: HR_DB,
    filter: {
      property: "اسم الموظف", // يجب أن يتطابق مع خاصية الاسم في HR_DB
      title: { equals: managerName }
    },
    page_size: 1
  });

  if (!result.results.length) {
    console.log("⚠️ No HR record found for", managerName);
    return null;
  }

  const page = result.results[0];
  const files = page.properties["الصورة الشخصية للموظف"]?.files; // يجب أن يتطابق مع خاصية الصورة في HR_DB

  if (!files || !files.length) {
    console.log("⚠️ HR record exists but no image for", managerName);
    return null;
  }

  const file = files[0];
  console.log("📸 HR Image Type:", file.type);

  // نعيد كائن الملف كاملاً كما هو لاستخدامه في تحديث الصفحة
  if (file.type === "file") {
    return {
      name: file.name,
      type: "file",
      file: {
        url: file.file.url,
        expiry_time: file.file.expiry_time // يجب تمرير تاريخ الانتهاء
      }
    };
  }
  if (file.type === "external") {
    return {
      name: file.name,
      type: "external",
      external: { url: file.external.url }
    };
  }

  return null;
}


// ---------------------------------------------------------
// FETCH ALL PROJECTS
// ---------------------------------------------------------
async function fetchAllProjects(db) {
  console.log("🚀 Fetching all projects…");
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

  console.log(`📁 Total projects: ${res.length}`);
  return res;
}

// ---------------------------------------------------------
// CREATE INLINE PROJECT DB
// ---------------------------------------------------------
async function createInlineProjectsDB(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…", managerPageId);

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
    title: [{ type: "text", text: { content: "مشاريعك" } }],
    properties: cleanProps,
    is_inline: true,
  });

  console.log("✅ INLINE DB CREATED:", newDb.id);
  return newDb.id;
}

// ---------------------------------------------------------
// ENSURE INLINE DB EXISTS
// ---------------------------------------------------------
async function ensureProjectsDB(managerPageId) {
  console.log("🔍 Checking inline DB for manager:", managerPageId);

  let cursor;
  while (true) {
    const r = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const b of r.results) {
      if (b.type === "child_database" && b.child_database?.title === "مشاريعك") {
        console.log("✅ Found existing inline Projects DB:", b.id);
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

  console.log(`\n============================`);
  console.log(`👤 Processing manager: ${managerName}`);
  console.log(`============================`);

  if (!managerName) throw new Error("❌ No manager name");

  if (managersCache.has(managerName)) return managersCache.get(managerName);

  // 👈 جلب كائن الملف (وليس مجرد URL)
  const managerFileObject = await getManagerFileObject(managerName);
  
  let imageProps = {};
  if (managerFileObject) {
    console.log("🖼 Manager file object retrieved.");
    imageProps["الصورة الشخصية للموظف"] = { // يجب أن يتطابق مع خاصية Files & Media في MANAGERS_DB
      files: [managerFileObject]
    };
  } else {
    console.log("🖼 No image file object to update.");
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
    console.log("📄 Existing manager page:", managerPageId);
    
    // تحديث الصفحة الموجودة بالصورة
    if (Object.keys(imageProps).length > 0) {
        await notion.pages.update({
            page_id: managerPageId,
            properties: imageProps,
        });
        console.log("✅ Image updated in existing manager page.");
    }
    
  } else {
    // إنشاء الصفحة الجديدة
    const created = await notion.pages.create({
      parent: { database_id: MANAGERS_DB },
      properties: {
        "اسم مدير المشروع": {
          title: [{ text: { content: managerName } }],
        },
        // إضافة خاصية الصورة عند الإنشاء
        ...imageProps
      },
    });

    managerPageId = created.id;
    stats.newManagerPages++;
    console.log("🆕 Created manager page:", managerPageId);
  }

  // INLINE DB
  const projectsDbId = await ensureProjectsDB(managerPageId);

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
    filter: { property: "اسم المشروع", title: { equals: projectName } },
  });

  const props = {
    "اسم المشروع": { title: [{ text: { content: projectName } }] },
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
    console.log("✏️ Updating existing project...");
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props,
    });
    stats.projectsUpdated++;
  } else {
    console.log("➕ Inserting new project...");
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

  console.log(`\n📂 Project: ${name}`);
  // console.log("Managers:", managers); // تم إزالة طباعة المعرّفات لتكون النتيجة أنظف

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
      console.error("❌ Manager error:", err.message);
    }
  }
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
  const stats = { total: 0, projectsInserted: 0, projectsUpdated: 0, newManagerPages: 0 };

  const projects = await fetchAllProjects(PROJECTS_DB);

  for (const p of projects) {
    try {
      await processProject(p, stats);
    } catch (err) {
      console.error("❌ Project error:", err.message);
    }
  }

  console.log("\n=== STATS ===");
  console.log(stats);
}

main();
