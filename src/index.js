import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ======================
// ثوابت
// ======================
const PROJECTS_DB = process.env.PROJECTS_DB;      // داتابيس المشاريع الأساسية
const MANAGERS_DB = process.env.MANAGERS_DB;      // داتابيس مدراء المشاريع
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID; // صفحة التيمبليت

const PROJECT_MANAGER_FIELD = "مدير المشروع"; // اسم العلاقة في داتابيس المشاريع
const CHILD_DB_TITLE = "مشاريعك"; // اسم داتابيس المشاريع داخل صفحة المدير (غيره لو اسمك مختلف)

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
// إيجاد داتا بيس "مشاريعك" داخل صفحة المدير
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
// نسخ محتوى التيمبليت لصفحة معيّنة
// - ينسخ كل البلوكات العادية
// - لو لقى child_database → ينشئ داتابيس جديد بنفس السكيمة
// ======================
async function copyTemplateContentToPage(targetPageId) {
  console.log(`📦 Copying template blocks into page: ${targetPageId}`);

  let cursor = undefined;

  do {
    const res = await notion.blocks.children.list({
      block_id: TEMPLATE_PAGE_ID,
      page_size: 50,
      start_cursor: cursor,
    });

    const normalBlocks = [];

    for (const block of res.results) {
      // لو البلوك داتابيس
      if (block.type === "child_database") {
        console.log(
          `🗂 Found child_database in template → cloning as inline DB in target page`
        );

        const templateDbId = block.id;

        // نجيب معلومات الداتابيس الأصلي
        const dbInfo = await notion.databases.retrieve({
          database_id: templateDbId,
        });

        // نجهز properties بدون id (عشان ما يعطي validation_error)
        const newProperties = {};
        for (const [name, prop] of Object.entries(dbInfo.properties)) {
          const { id, ...rest } = prop;
          newProperties[name] = rest;
        }

        // ننشئ داتابيس جديد داخل صفحة المدير
        await notion.databases.create({
          parent: { type: "page_id", page_id: targetPageId },
          title: dbInfo.title, // نفس العنوان
          is_inline: true, // يكون inline داخل الصفحة
          properties: newProperties, // نفس الأعمدة
        });

        console.log(`✅ Cloned inline database in manager page`);
      } else if (block.object === "block") {
        // باقي البلوكات العادية ننسخها كما هي
        const { type } = block;
        normalBlocks.push({
          object: "block",
          type,
          [type]: block[type],
        });
      }
    }

    if (normalBlocks.length) {
      await notion.blocks.children.append({
        block_id: targetPageId,
        children: normalBlocks,
      });
    }

    cursor = res.has_more ? res.next_cursor || undefined : undefined;
  } while (cursor);
}

// ======================
// التأكد من وجود داتابيس "مشاريعك" داخل صفحة المدير
// إذا ما وُجدت → ننسخ التيمبليت (مع استنساخ الداتابيس) ثم نبحث مرة ثانية
// ======================
async function ensureChildDbExists(managerPageId) {
  // أولاً نحاول نلقاه
  let childDbId = await findChildProjectsDb(managerPageId);
  if (childDbId) return childDbId;

  console.log(
    `🧩 No child DB "${CHILD_DB_TITLE}" in manager page → copying template content...`
  );

  // ننسخ محتوى التيمبليت (مع استنساخ الداتابيس)
  await copyTemplateContentToPage(managerPageId);

  // نبحث مرة ثانية بعد النسخ
  childDbId = await findChildProjectsDb(managerPageId);
  if (!childDbId) {
    console.log(
      `❌ ERROR: Still no child DB "${CHILD_DB_TITLE}" after copying template content!`
    );
  } else {
    console.log(`✅ Child DB "${CHILD_DB_TITLE}" found after copy`);
  }

  return childDbId;
}

// ======================
// إنشاء صفحة مدير جديدة + نسخ التيمبليت عليها
// ======================
async function duplicateTemplate(managerName) {
  console.log(`\n📄 Creating page for manager: ${managerName}`);

  // إنشاء صفحة جديدة في MANAGERS_DB
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
  });

  const newPageId = page.id;

  // نسخ محتوى التيمبليت لهذه الصفحة (مع استنساخ الداتابيس)
  await copyTemplateContentToPage(newPageId);

  console.log(
    `✅ Page created & template content copied → Page ID: ${newPageId}`
  );
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
        // صفحة المدير المرتبطة من علاقة "مدير المشروع"
        const managerPage = await notion.pages.retrieve({
          page_id: m.id,
        });

        const managerName = getPageTitle(managerPage);

        // إيجاد أو إنشاء صفحة المدير في MANAGERS_DB
        const managerMainPageId = await findOrCreateManagerPage(managerName);

        // التأكد من وجود داتابيس "مشاريعك" داخل صفحة المدير (ولو ناقصة ينسخ التيمبليت)
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

// ======================
// تشغيل السكربت
// ======================
sync().catch((err) => {
  console.error(err);
  process.exit(1);
});
