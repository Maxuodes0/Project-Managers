// src/PM_Team_Projects_Reconcile.js
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
// GET PROJECT STATUS FROM MAIN PROJECTS_DB
// ---------------------------------------------------------
async function getMainProjectStatus(projectName) {
  const res = await notion.databases.query({
    database_id: PROJECTS_DB,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
    page_size: 1,
  });

  if (!res.results.length) return null;

  return getSelect(res.results[0], "حالة المشروع");
}

// ---------------------------------------------------------
// MAIN LOGIC
// ---------------------------------------------------------
async function main() {
  console.log("🔁 STARTING PM_Team_Projects_Reconcile");

  const managers = await listAllPages(MANAGERS_DB);

  for (const manager of managers) {
    const managerPageId = manager.id;

    // ابحث عن DB "مشاريعك"
    const blocks = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
    });

    const projectsDbBlock = blocks.results.find(
      b => b.type === "child_database" && b.child_database?.title === "مشاريعك"
    );

    if (!projectsDbBlock) continue;

    // جلب مشاريع المدير
    const projects = await listAllPages(projectsDbBlock.id);

    for (const project of projects) {
      const projectName = getTitle(project, "اسم المشروع");
      if (!projectName) continue;

      const managerStatus = getSelect(project, "حالة المشروع");
      const source = getSelect(project, "آخر مصدر تحديث");

      // ❌ لا نتحرك إلا لو آخر تعديل كان من النظام
      if (source !== "النظام") continue;

      const mainStatus = await getMainProjectStatus(projectName);
      if (!mainStatus) continue;

      // لو متطابقين → لا شيء
      if (managerStatus === mainStatus) continue;

      // فرض حالة PROJECTS_DB على مشاريعك
      await notion.pages.update({
        page_id: project.id,
        properties: {
          "حالة المشروع": {
            select: { name: mainStatus },
          },
          // نترك المصدر = النظام (توثيق)
          "آخر مصدر تحديث": {
            select: { name: "النظام" },
          },
        },
      });

      console.log(
        `♻️ Reconciled "${projectName}" | ${managerStatus} → ${mainStatus}`
      );
    }
  }

  console.log("✅ PM_Team_Projects_Reconcile finished");
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
