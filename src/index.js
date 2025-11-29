import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ثابتة الأسماء
const PROJECTS_DB = process.env.PROJECTS_DB;
const MANAGERS_DB = process.env.MANAGERS_DB;
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID;

const PROJECT_MANAGER_FIELD = "مدير المشروع"; // اسم الحقل EXACT
const CHILD_DB_TITLE = "مشاريعك"; // اسم داتابيس المشاريع داخل التيمبليت

// نضمن توفر المتغيرات الأساسية
const REQUIRED_ENV = ["NOTION_TOKEN", "PROJECTS_DB", "MANAGERS_DB", "TEMPLATE_PAGE_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`❌ متغير البيئة ${key} مفقود. أضفه قبل التشغيل.`);
  }
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
// جلب كل البلوكات مع التصفح
// ======================
async function fetchAllBlocks(blockId) {
  const results = [];
  let cursor;

  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 50,
      start_cursor: cursor,
    });

    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return results;
}

// نبني بلوك جديد فقط بالخصائص المدعومة مع نسخ الأطفال
async function buildBlockTree(block) {
  const { type } = block;

  // child_page / child_database لا يمكن نسخها بنفس الطريقة
  if (!type || type === "child_page" || type === "child_database") {
    return null;
  }

  if (!block[type]) return null;

  const cloned = {
    type,
    [type]: { ...block[type] },
  };

  // إزالة حقول ميتا غير مسموحة
  delete cloned[type].id;
  delete cloned[type].created_time;
  delete cloned[type].last_edited_time;
  delete cloned[type].last_edited_by;
  delete cloned[type].created_by;

  if (block.has_children) {
    const children = await fetchAllBlocks(block.id);
    const mapped = [];

    for (const child of children) {
      const childTree = await buildBlockTree(child);
      if (childTree) mapped.push(childTree);
    }

    if (mapped.length) cloned.children = mapped;
  }

  return cloned;
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
// تجهيز خصائص داتابيس مشاريعك (مأخوذة من قاعدة المشاريع الأصلية)
// ======================
let cachedProjectDbProps = null;
async function getProjectDbPropertiesForSubDb() {
  if (cachedProjectDbProps) return cachedProjectDbProps;

  const mainDb = await notion.databases.retrieve({ database_id: PROJECTS_DB });
  const required = [
    { target: "اسم المشروع", source: "اسم المشروع" },
    { target: "حالة المشروع", source: "حالة المشروع" },
    { target: "المتبقي", source: "المبلغ المتبقي" },
    { target: "فواتير", source: "فواتير" },
    { target: "صورة المشروع", source: "صورة المشروع" },
  ];
  const properties = {};

  for (const { target, source } of required) {
    const prop = mainDb.properties?.[source];
    if (!prop) continue;
    const type = prop.type;
    if (!type || !prop[type]) continue;
    properties[target] = { [type]: prop[type] };
  }

  if (!properties["اسم المشروع"]) {
    properties["اسم المشروع"] = { title: {} };
  }

  cachedProjectDbProps = properties;
  return properties;
}

// إنشاء قاعدة مشاريع جديدة تحت صفحة المدير
async function createSubDatabase(managerPageId, title = CHILD_DB_TITLE) {
  const properties = await getProjectDbPropertiesForSubDb();

  const db = await notion.databases.create({
    parent: { page_id: managerPageId },
    title: [
      {
        type: "text",
        text: { content: title },
      },
    ],
    properties,
  });

  console.log(`✅ تم إنشاء قاعدة "${title}" تحت صفحة المدير`);
  return db.id;
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
  let createdChildDbId = null;

  // جلب محتوى التيمبليت
  const templateBlocks = await fetchAllBlocks(TEMPLATE_PAGE_ID);

  // نسخ المحتوى
  for (const block of templateBlocks) {
    // child_database لا يمكن نسخه مباشرة عبر blocks.append → ننشئ قاعدة جديدة بنفس الاسم
    if (block.type === "child_database") {
      const title = block.child_database?.title || CHILD_DB_TITLE;
      const dbId = await createSubDatabase(newPageId, title);
      if (title === CHILD_DB_TITLE) {
        createdChildDbId = dbId;
      }
      continue;
    }

    const tree = await buildBlockTree(block);
    if (!tree) {
      console.log(`⚠️ تخطي بلوك غير مدعوم: ${block.type}`);
      continue;
    }

    await notion.blocks.children.append({
      block_id: newPageId,
      children: [tree],
    });
  }

  console.log(`✅ Template copied → Page ID: ${newPageId}`);
  return { managerPageId: newPageId, childDbId: createdChildDbId };
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
    const pageId = search.results[0].id;
    const existingChildDb = await findChildProjectsDb(pageId);
    return { managerPageId: pageId, childDbId: existingChildDb };
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
        const { managerPageId, childDbId: childDbFromTemplate } =
          await findOrCreateManagerPage(managerName);

        // إيجاد داتا بيس مشاريعك داخل الصفحة (أولوية للتي تم إنشاؤها أثناء نسخ التيمبليت)
        let childDbId = childDbFromTemplate || (await findChildProjectsDb(managerPageId));
        if (!childDbId) {
          console.log(
            `⚠️ No child DB "${CHILD_DB_TITLE}" found. سيتم إنشاء واحدة جديدة.`
          );
          try {
            childDbId = await createSubDatabase(managerPageId, CHILD_DB_TITLE);
          } catch (createErr) {
            console.log(
              `❌ ERROR: فشل إنشاء قاعدة "${CHILD_DB_TITLE}": ${createErr.message}`
            );
            continue;
          }
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
