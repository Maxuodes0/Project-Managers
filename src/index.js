import { Client } from "@notionhq/client";

// --------------------------------------
// 1- Notion Setup
// --------------------------------------
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const PROJECTS_DB = process.env.PROJECTS_DB;           // قاعدة المشاريع
const MANAGERS_DB = process.env.MANAGERS_DB;           // قاعدة مدراء المشاريع
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID; // صفحة التيمبليت الجاهزة

// اسم قاعدة البيانات داخل صفحة المدير
const SUB_DB_NAME = "مشاريعك";

console.log("🚀 Starting SYNC...");

// --------------------------------------
// 2- Get all projects from Projects DB (مع دعم pagination)
// --------------------------------------
async function getAllProjects() {
  const results = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: PROJECTS_DB,
      start_cursor: cursor,
      page_size: 100,
    });

    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

// --------------------------------------
// 3- Find manager page by name
// --------------------------------------
async function findManagerPage(managerName) {
  console.log(`🔍 Searching manager page: ${managerName}`);

  const response = await notion.databases.query({
    database_id: MANAGERS_DB,
    filter: {
      property: "اسم مدير المشروع",
      title: {
        equals: managerName,
      },
    },
  });

  if (response.results.length > 0) {
    const page = response.results[0];
    console.log(`✅ Found manager page: ${managerName}`);
    return page.id;
  }

  console.log(`➕ Page not found → will create from template`);
  return null;
}

// --------------------------------------
// 4- Create manager page FROM TEMPLATE
// --------------------------------------
async function createManagerPageFromTemplate(managerName) {
  console.log(`📄 Creating page for manager: ${managerName}`);

  const newPage = await notion.pages.create({
    parent: {
      database_id: MANAGERS_DB,
    },
    properties: {
      "اسم مدير المشروع": {
        title: [
          {
            text: {
              content: managerName,
            },
          },
        ],
      },
    },
  });

  // ننسخ محتوى التيمبليت داخل الصفحة الجديدة
  await copyTemplateContent(TEMPLATE_PAGE_ID, newPage.id);

  console.log(`✅ Manager page created: ${managerName}`);
  return newPage.id;
}

// --------------------------------------
// 5- Get ALL blocks from a page (with pagination)
// --------------------------------------
async function getAllBlocks(blockId) {
  const blocks = [];
  let cursor = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

// --------------------------------------
// 6- Duplicate content inside template page
//    مع تنظيف الحقول اللي ما يقبلها الـ API
// --------------------------------------
async function copyTemplateContent(templateId, newPageId) {
  const rawBlocks = await getAllBlocks(templateId);

  if (!rawBlocks.length) {
    console.log("⚠️ Template has no blocks");
    return;
  }

  console.log(`📦 Copying ${rawBlocks.length} blocks from template...`);

  // نحذف الحقول اللي Notion ما يسمح نرسلها ونخلي البلوك بأقرب شكل للأصلي
  const cleanedBlocks = rawBlocks
    .filter((block) => block.object === "block")
    .map((block) => {
      const {
        id,
        created_time,
        last_edited_time,
        created_by,
        last_edited_by,
        archived,
        has_children,
        object,
        ...rest
      } = block;
      return rest;
    });

  // Notion يسمح حتى 100 بلوك في كل عملية append
  const chunkSize = 100;
  for (let i = 0; i < cleanedBlocks.length; i += chunkSize) {
    const chunk = cleanedBlocks.slice(i, i + chunkSize);
    await notion.blocks.children.append({
      block_id: newPageId,
      children: chunk,
    });
  }

  console.log("✅ Template content copied.");
}

// --------------------------------------
// 7- Find "مشاريعك" database inside manager page
// --------------------------------------
async function findSubDatabase(managerPageId) {
  console.log(`🔍 Scanning page for child DB: ${SUB_DB_NAME}`);

  const children = await getAllBlocks(managerPageId);

  for (const block of children) {
    if (block.type === "child_database") {
      if (block.child_database.title === SUB_DB_NAME) {
        console.log("✅ Found sub database:", SUB_DB_NAME);
        return block.id;
      }
    }
  }

  console.log("❌ Sub database not found.");
  return null;
}

// --------------------------------------
// 8- Insert project into manager's "مشاريعك" DB
// --------------------------------------
async function insertProject(subDbId, project) {
  const projectNameProp = project.properties["اسم المشروع"];
  const projectName =
    projectNameProp?.title?.[0]?.plain_text || "بدون اسم";

  console.log(`➕ Adding project: ${projectName}`);

  await notion.pages.create({
    parent: { database_id: subDbId },
    properties: {
      "اسم المشروع": project.properties["اسم المشروع"],
      "حالة المشروع": project.properties["حالة المشروع"],
      "المتبقي": project.properties["المبلغ المتبقي"],
      "فواتير": project.properties["فواتير"] || { files: [] },
      "صورة المشروع":
        project.properties["صورة المشروع"] || { files: [] },
    },
  });

  console.log("✅ Project added.");
}

// --------------------------------------
// 9- Main sync logic
// --------------------------------------
async function sync() {
  const projects = await getAllProjects();

  for (const project of projects) {
    const managerRelation = project.properties["مدير المشروع"];

    if (!managerRelation || !managerRelation.relation.length) {
      console.log("⚠️ Project has no manager, skipping.");
      continue;
    }

    // ملاحظة: relation عادة فيها id فقط
    // لو تحتاج الاسم فعلياً، يفضل تخزنه كنص في نفس قاعدة المشاريع
    const managerName =
      managerRelation.relation[0].name || "مدير";

    // 1) Find or Create Manager Page
    let managerPageId = await findManagerPage(managerName);

    if (!managerPageId) {
      managerPageId = await createManagerPageFromTemplate(managerName);
    }

    // 2) Find "مشاريعك" DB
    const subDbId = await findSubDatabase(managerPageId);
    if (!subDbId) {
      console.log(
        `❌ ERROR: "مشاريعك" not found inside manager page. Please fix template.`
      );
      continue;
    }

    // 3) Insert project
    await insertProject(subDbId, project);
  }

  console.log("🎉 SYNC COMPLETED.");
}

// --------------------------------------
// 10- Run
// --------------------------------------
sync().catch((err) => {
  console.error("💥 Unhandled Error:", err);
});
