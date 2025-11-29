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
// sleep بسيط
// ======================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  let cursor = undefined;

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

    cursor = res.has_more ? res.next_cursor || undefined : undefined;
  } while (cursor);

  return null;
}

// ======================
// التأكد من وجود داتابيس "مشاريعك" داخل صفحة المدير
// إذا ما وُجدت → نطبّق التيمبليت على الصفحة ثم ننتظر لين يظهر
// ======================
async function ensureChildDbExists(managerPageId) {
  // أولاً نحاول نلقاه
  let childDbId = await findChildProjectsDb(managerPageId);
  if (childDbId) return childDbId;

  console.log(
    `🧩 No child DB "${CHILD_DB_TITLE}" in manager page → applying template...`
  );

  // نطبّق التيمبليت على صفحة موجودة
  await notion.pages.update({
    page_id: managerPageId,
    template: {
      type: "template_id",
      template_id: TEMPLATE_PAGE_ID,
    },
    // erase_content: false  // نخلي المحتوى القديم (لو فيه شيء)
  });

  // التيمبليت يتطبق async، فننتظر شوي ونحاول نقرأ مرة ثانية
  const maxTries = 5;
  for (let i = 0; i < maxTries; i++) {
    await sleep(1500); // 1.5 ثانية
    childDbId = await findChildProjectsDb(managerPageId);
    if (childDbId) {
      console.log(
        `✅ Child DB "${CHILD_DB_TITLE}" found after applying template`
      );
      return childDbId;
    }
  }

  console.log(
    `❌ ERROR: Still no child DB "${CHILD_DB_TITLE}" after applying template!`
  );
  return null;
}

// ======================
// إنشاء صفحة مدير من التيمبليت مباشرة
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
    // هنا السحر: نستخدم التيمبليت
    template: {
      type: "template_id",
      template_id: TEMPLATE_PAGE_ID,
    },
  });

  console.log(`✅ Page created from template → Page ID: ${page.id}`);
  return page.id;
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
// إضافة/تعديل مشروع داخل "مشاريعك"
// ======================
async function upsertProject(childDbId, projectName, status, remaining) {
  const props = {
    "اسم المشروع": {
      title: [{ text: { content: projectName } }],
    },
  };

  if (status) {
    props["حالة المشروع"] = { select: { name: status } };
  }
  if (remaining != null) {
    props["المتبقي"] = { number: remaining };
  }

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

  let cursor = undefined;

  do {
    const res = await notion.databases.query({
      database_id: PROJECTS_DB,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const project of res.results) {
      const projectName =
        project.properties["اسم المشروع"].title?.[0]?.plain_text ||
        "بدون اسم";

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
        // صفحة المدير المرتبطة
        const managerPage = await notion.pages.retrieve({
          page_id: m.id,
        });

        const managerName = getPageTitle(managerPage);

        // إيجاد أو إنشاء صفحة المدير في MANAGERS_DB
        const managerMainPageId = await findOrCreateManagerPage(managerName);

        // التأكد من وجود داتابيس "مشاريعك" داخل صفحة المدير (وتطبيق التيمبليت لو ناقص)
        const childDbId = await ensureChildDbExists(managerMainPageId);
        if (!childDbId) {
          console.log(
            `❌ ERROR: No child DB "${CHILD_DB_TITLE}" found/created in manager page!`
          );
          continue;
        }

        // تحديث/إضافة المشروع داخل داتابيس "مشاريعك"
        await upsertProject(childDbId, projectName, status, remaining);
      }
    }

    cursor = res.has_more ? res.next_cursor || undefined : undefined;
  } while (cursor);

  console.log("\n🎉 SYNC FINISHED");
}

// تشغيل
sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
