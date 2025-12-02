```js
import { Client } from "@notionhq/client";
import "dotenv/config";

// ======================
// Helpers: ENV Validation
// ======================
function assertEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing env var: ${name}`);
  }
}

assertEnv("NOTION_TOKEN");
assertEnv("PROJECTS_DB");
assertEnv("MANAGERS_DB");
assertEnv("TEMPLATE_PAGE_ID");

// ======================
// Notion Client + Constants
// ======================
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const PROJECTS_DB = process.env.PROJECTS_DB; // داتابيس المشاريع الأساسية
const MANAGERS_DB = process.env.MANAGERS_DB; // داتابيس مدراء المشاريع
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID; // صفحة التيمبليت

const PROJECT_MANAGER_FIELD = "مدير المشروع"; // اسم العلاقة في داتابيس المشاريع
const CHILD_DB_TITLE = "مشاريعك"; // اسم داتابيس المشاريع داخل صفحة المدير

// كاش للمدراء عشان نقلل عدد طلبات Notion
// key: managerName, value: { managerMainPageId, childDbId }
const managerCache = new Map();

// إحصائيات بسيطة
const stats = {
  projectsProcessed: 0,
  projectsInserted: 0,
  projectsUpdated: 0,
  managersCreated: 0,
};

// ======================
// Helpers: قراءة خصائص الصفحة
// ======================
function getPageTitle(page, fallback = "بدون عنوان") {
  const props = page.properties;
  for (const key in props) {
    if (props[key]?.type === "title") {
      return props[key].title?.[0]?.plain_text || fallback;
    }
  }
  return fallback;
}

function getTitleProp(page, propName, fallback = "بدون اسم") {
  const prop = page.properties[propName];
  if (prop?.type === "title" && prop.title[0]?.plain_text) {
    return prop.title[0].plain_text;
  }
  return fallback;
}

function getSelectName(page, propName) {
  const prop = page.properties[propName];
  if (prop?.type === "select" && prop.select?.name) {
    return prop.select.name;
  }
  return null;
}

function getFormulaNumber(page, propName) {
  const prop = page.properties[propName];
  if (prop?.type === "formula" && typeof prop.formula?.number === "number") {
    return prop.formula.number;
  }
  return null;
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
// إذا ما وُجدت → ننسخ التيمبليت ثم نبحث مرة ثانية
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
  stats.managersCreated++;

  // نسخ محتوى التيمبليت لهذه الصفحة (مع استنساخ الداتابيس)
  await copyTemplateContentToPage(newPageId);

  console.log(
    `✅ Page created & template content copied → Page ID: ${newPageId}`
  );
  return newPageId;
}

// ======================
// إيجاد أو إنشاء صفحة المدير في MANAGERS_DB
// ======================
async function findOrCreateManagerPage(managerName) {
  console.log(`\n🔍 Searching manager page in MANAGERS_DB: ${managerName}`);

  const search = await notion.databases.query({
    database_id: MANAGERS_DB,
    filter: {
      property: "اسم مدير المشروع",
      title: { equals: managerName },
    },
  });

  if (search.results.length > 0) {
    console.log(`✔️ Found existing manager page`);
    return search.results[0].id;
  }

  console.log(`➕ Manager page not found → creating from template`);
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
    console.log(`✏️ Updating project in manager DB: ${projectName}`);
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props,
    });
    stats.projectsUpdated++;
  } else {
    console.log(`➕ Adding new project in manager DB: ${projectName}`);
    await notion.pages.create({
      parent: { database_id: childDbId },
      properties: props,
    });
    stats.projectsInserted++;
  }
}

// ======================
// الحصول على (managerMainPageId + childDbId) من الكاش أو من Notion
// ======================
async function getManagerPagesForName(managerName) {
  if (managerCache.has(managerName)) {
    return managerCache.get(managerName);
  }

  const managerMainPageId = await findOrCreateManagerPage(managerName);
  const childDbId = await ensureChildDbExists(managerMainPageId);

  const value = { managerMainPageId, childDbId };
  managerCache.set(managerName, value);
  return value;
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
      stats.projectsProcessed++;

      try {
        const projectName = getTitleProp(project, "اسم المشروع", "بدون اسم");
        const status = getSelectName(project, "حالة المشروع");
        const remaining = getFormulaNumber(project, "المبلغ المتبقي");

        const managersProp = project.properties[PROJECT_MANAGER_FIELD];
        const managers = managersProp?.type === "relation"
          ? managersProp.relation
          : [];

        if (!managers.length) {
          console.log(`⚠️ Project "${projectName}" has no manager`);
          continue;
        }

        for (const m of managers) {
          // صفحة المدير المرتبطة من علاقة "مدير المشروع" في PROJECTS_DB
          const managerPage = await notion.pages.retrieve({
            page_id: m.id,
          });

          const managerName = getPageTitle(managerPage, "مدير بدون اسم");

          // من MANAGERS_DB: صفحة المدير + داتابيس "مشاريعك"
          const { childDbId } = await getManagerPagesForName(managerName);

          if (!childDbId) {
            console.log(
              `❌ ERROR: No child DB "${CHILD_DB_TITLE}" found/created in manager page for: ${managerName}`
            );
            continue;
          }

          // تحديث/إضافة المشروع داخل داتابيس "مشاريعك"
          await upsertProject(childDbId, projectName, status, remaining);
        }
      } catch (err) {
        console.error(
          `❌ Error while processing project ${project.id}:`,
          err.message || err
        );
      }
    }

    cursor = res.has_more ? res.next_cursor || undefined : undefined;
  } while (cursor);

  console.log("\n🎉 SYNC FINISHED");
  console.log("=== SYNC SUMMARY ===");
  console.log(stats);
}

// ======================
// تشغيل السكربت
// ======================
sync().catch((err) => {
  console.error("❌ Fatal error in SYNC:", err);
  process.exit(1);
});
```
