// src/PM_Team_Projects_Updateds.js
import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// ---------------------------------------------------------
// ENV
// ---------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const MANAGERS_DB = process.env.MANAGERS_DB;
const PROJECTS_DB = process.env.PROJECTS_DB;

if (!NOTION_TOKEN || !MANAGERS_DB || !PROJECTS_DB) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
async function listAllPages(databaseId) {
  const results = [];
  let cursor;

  while (true) {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  return results;
}

function getTitle(page, prop) {
  return page.properties[prop]?.title?.map(t => t.plain_text).join("") || null;
}

function getSelect(page, prop) {
  return page.properties[prop]?.select?.name || null;
}

// ---------------------------------------------------------
// ENSURE CHILD DATABASE EXISTS
// ---------------------------------------------------------
async function ensureChildDatabase(pageId, title, properties) {
  const blocks = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  const exists = blocks.results.find(
    b => b.type === "child_database" && b.child_database?.title === title
  );

  if (exists) return exists.id;

  const created = await notion.databases.create({
    parent: { type: "page_id", page_id: pageId },
    title: [{ type: "text", text: { content: title } }],
    is_inline: true,
    properties,
  });

  console.log(`✅ Created DB "${title}"`);
  return created.id;
}

// ---------------------------------------------------------
// SCHEMAS
// ---------------------------------------------------------
const FREELANCE_SCHEMA = {
  "نوع الصرف": { title: {} },
  "اسم الشخص": { rich_text: {} },
  "العمل": { rich_text: {} },
  "المبلغ": { number: { format: "number" } },
  "آيبان": { rich_text: {} },
  "حالة الدفع": {
    select: {
      options: [
        { name: "مكتمل", color: "green" },
        { name: "جزئي", color: "yellow" },
        { name: "غير مدفوع", color: "red" },
      ],
    },
  },
  "إيصال": { files: {} },
};

const PURCHASES_SCHEMA = {
  "نوع المصروف": { title: {} },
  "تاريخ": { date: {} },
  "المبلغ": { number: { format: "number" } },
  "المبلغ بدون ضريبة": { number: { format: "number" } },
  "إرفاق الفاتورة": { files: {} },
  "دافع المبلغ": {
    select: {
      options: [
        { name: "الشركة", color: "blue" },
        { name: "المدير", color: "gray" },
      ],
    },
  },
};

// ---------------------------------------------------------
// UPDATE PROJECT STATUS IN MAIN DB
// ---------------------------------------------------------
async function updateMainProjectStatus(projectName, statusFromManager) {
  if (!statusFromManager) return;

  const res = await notion.databases.query({
    database_id: PROJECTS_DB,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
    page_size: 1,
  });

  if (!res.results.length) return;

  const page = res.results[0];
  const currentStatus = getSelect(page, "حالة المشروع");

  if (currentStatus === statusFromManager) return;

  await notion.pages.update({
    page_id: page.id,
    properties: {
      "حالة المشروع": {
        select: { name: statusFromManager },
      },
    },
  });

  console.log(`🔄 Updated main project "${projectName}" → ${statusFromManager}`);
}

// ---------------------------------------------------------
// MAIN LOGIC
// ---------------------------------------------------------
async function main() {
  console.log("🚀 Starting PM_Team_Projects_Updateds");

  const managers = await listAllPages(MANAGERS_DB);

  for (const manager of managers) {
    const managerPageId = manager.id;

    // Find "مشاريعك" DB
    const blocks = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
    });

    const projectsDbBlock = blocks.results.find(
      b => b.type === "child_database" && b.child_database?.title === "مشاريعك"
    );

    if (!projectsDbBlock) continue;

    const projects = await listAllPages(projectsDbBlock.id);

    for (const project of projects) {
      const projectName = getTitle(project, "اسم المشروع");
      const projectStatus = getSelect(project, "حالة المشروع");

      if (!projectName) continue;

      // 1️⃣ Ensure child DBs
      await ensureChildDatabase(
        project.id,
        "فريق الفرعي لانس",
        FREELANCE_SCHEMA
      );

      await ensureChildDatabase(
        project.id,
        "المشتريات",
        PURCHASES_SCHEMA
      );

      // 2️⃣ Sync status back to main PROJECTS_DB
      await updateMainProjectStatus(projectName, projectStatus);
    }
  }

  console.log("✅ PM_Team_Projects_Updateds finished");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
