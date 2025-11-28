import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ثابتة الأسماء
const PROJECTS_DB = process.env.PROJECTS_DB;
const MANAGERS_DB = process.env.MANAGERS_DB;
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID;

const PROJECT_MANAGER_FIELD = "مدير المشروع"; // اسم الحقل EXACT
const CHILD_DB_TITLE = "مشاريعك"; // اسم داتابيس المشاريع داخل التيمبليت

// ======================
// جلب عنوان أي صفحة
// ======================
function getPageTitle(page) {
  const props = page.properties;
  for (const key in props) {
    if (props[key]?.type === "title") {
      return props[key].title?.[0]?.plain_text || "بدون عنوان";
    }
  }
  return "بدون عنوان";
}

// ======================
// إيجاد داتا بيس مشاريعك داخل الصفحة
// ======================
async function findChildProjectsDb(managerPageId) {
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      if (block.type === "child_database") {
        if (block.child_database.title === CHILD_DB_TITLE) {
          return block.id;
        }
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return null;
}

// ======================
// نسخ التيمبليت
// ======================
async function duplicateTemplate(managerName) {
  console.log(`\n📄 Creating page for manager: ${managerName}`);

  const page = await notion.pages.create({
    parent: { database_id: MANAGERS_DB },
    properties: {
      "اسم مدير المشروع": {
        title: [
          {
            type: "text",
            text: { content: managerName },
          },
        ],
      },
    },
    // محتوى الصفحة يأتي من التيمبليت كمحتوى فارغ: سننسخه يدوي
  });

  const newPageId = page.id;

  // جلب محتوى التيمبليت
  const templateContent = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
  });

  // نسخ المحتوى
  for (const block of templateContent.results) {
    await notion.blocks.children.append({
      block_id: newPageId,
      children: [block],
    });
  }

  console.log(`✅ Template copied → Page ID: ${newPageId}`);
  return newPageId;
}

// ======================
// إيجاد أو إنشاء صفحة المدير
// ======================
async function findOrCreateManagerPage(managerName) {
  console.log(`\n🔍 Searching manager page: ${managerName}`);

  const search = await notion.databases.query({
    database_id: MANAGERS_DB,
    filter: {
      property: "اسم مدير المشروع",
      title: { equals: managerName },
    },
  });

  if (search.results.length > 0) {
    console.log(`✔️ Found existing page`);
    return search.results[0].id;
  }

  console.log(`➕ Page not found → creating from template`);
  return await duplicateTemplate(managerName);
}

// ======================
// إضافة مشروع داخل "مشاريعك"
// ======================
async function upsertProject(childDbId, projectName, status, remaining) {
  const props = {
    "اسم المشروع": {
      title: [{ text: { content: projectName } }],
    },
    "حالة المشروع": status
      ? { select: { name: status } }
      : undefined,
    "المتبقي": remaining != null ? { number: remaining } : undefined,
  };

  // هل موجود نفس المشروع؟
  const existing = await notion.databases.query({
    database_id: childDbId,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
  });

  if (existing.results.length > 0) {
    console.log(`✏️ Updating project: ${projectName}`);
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props,
    });
  } else {
    console.log(`➕ Adding new project: ${projectName}`);
    await notion.pages.create({
      parent: { database_id: childDbId },
      properties: props,
    });
  }
}

// ======================
// مزامنة كل المشاريع
// ======================
async function sync() {
  console.log("🚀 Starting SYNC...");

  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: PROJECTS_DB,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const project of res.results) {
      const projectName =
        project.properties["اسم المشروع"].title?.[0]?.plain_text;

      const status =
        project.properties["حالة المشروع"].select?.name || null;

      const remaining =
        project.properties["المبلغ المتبقي"].formula?.number ?? null;

      const managers = project.properties[PROJECT_MANAGER_FIELD].relation;

      if (!managers.length) {
        console.log(`⚠️ Project "${projectName}" has no manager`);
        continue;
      }

      for (const m of managers) {
        const managerPage = await notion.pages.retrieve({
          page_id: m.id,
        });

        const managerName = getPageTitle(managerPage);

        // إيجاد أو إنشاء صفحة المدير
        const managerMainPage = await findOrCreateManagerPage(managerName);

        // إيجاد داتا بيس مشاريعك داخل الصفحة
        const childDbId = await findChildProjectsDb(managerMainPage);
        if (!childDbId) {
          console.log(
            `❌ ERROR: No child DB "${CHILD_DB_TITLE}" found in template page!`
          );
          continue;
        }

        await upsertProject(
          childDbId,
          projectName,
          status,
          remaining
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  console.log("\n🎉 SYNC FINISHED");
}

// تشغيل
sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
