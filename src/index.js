import { Client } from "@notionhq/client";

// --------------------------------------
// 1- إعداد Notion + التحقق من المتغيرات
// --------------------------------------
const REQUIRED_ENV = ["NOTION_TOKEN", "PROJECTS_DB", "MANAGERS_DB", "TEMPLATE_PAGE_ID"];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`❌ متغير البيئة ${key} مفقود. أضفه قبل التشغيل.`);
  }
}

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const PROJECTS_DB = process.env.PROJECTS_DB; // قاعدة المشاريع
const MANAGERS_DB = process.env.MANAGERS_DB; // قاعدة مدراء المشاريع
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID; // صفحة التيمبليت الجاهزة

// اسم قاعدة البيانات داخل صفحة المدير (يمكن تغييرها من هنا)
const SUB_DB_NAME = "مشاريعك";

// أسماء الخصائص لتجنّب التكرار + لتسهيل تعديلها لاحقاً
const PROPERTY = {
  projectName: "اسم المشروع",
  projectStatus: "حالة المشروع",
  projectRemaining: "المبلغ المتبقي",
  projectInvoices: "فواتير",
  projectImage: "صورة المشروع",
  projectManager: "مدير المشروع",
  managerTitle: "اسم مدير المشروع",
};

// --------------------------------------
// 2- Helpers
// --------------------------------------
async function fetchAllDatabaseItems(databaseId, filter) {
  const results = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter,
      start_cursor: cursor,
    });

    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return results;
}

async function fetchAllBlocks(blockId) {
  const results = [];
  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
    });
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return results;
}

// نفصل أخذ اسم المدير لأن relation يعطينا فقط الـ id
const managerNameCache = new Map();
async function resolveManagerName(managerRelation) {
  if (!managerRelation || !managerRelation.relation.length) return null;

  const managerPageId = managerRelation.relation[0].id;
  if (managerNameCache.has(managerPageId)) {
    return managerNameCache.get(managerPageId);
  }

  const page = await notion.pages.retrieve({ page_id: managerPageId });
  const titleProp = page.properties?.[PROPERTY.managerTitle]?.title || page.properties?.Name?.title;
  const managerName = titleProp?.[0]?.plain_text || null;

  managerNameCache.set(managerPageId, managerName);
  return managerName;
}

// نبني بلوك جديد بدون المعرفات مع نسخ الأطفال
function cloneBlockStructure(block) {
  const { type } = block;
  if (!type || !block[type]) return null;

  const cloned = {
    type,
    [type]: { ...block[type] },
  };

  // إزالة قيم لا تُستخدم في الإنشاء
  delete cloned[type].id;
  delete cloned[type].created_time;
  delete cloned[type].last_edited_time;
  delete cloned[type].last_edited_by;
  delete cloned[type].created_by;

  return cloned;
}

async function buildBlockTree(block) {
  const cloned = cloneBlockStructure(block);
  if (!cloned) return null;

  if (block.has_children) {
    const children = await fetchAllBlocks(block.id);
    const mapped = [];

    for (const child of children) {
      const built = await buildBlockTree(child);
      if (built) mapped.push(built);
    }

    if (mapped.length) cloned.children = mapped;
  }

  return cloned;
}

console.log("🚀 Starting SYNC...");

// --------------------------------------
// 3- Get all projects from Projects DB
// --------------------------------------
async function getAllProjects() {
  return fetchAllDatabaseItems(PROJECTS_DB);
}

// --------------------------------------
// 4- Find manager page by name
// --------------------------------------
async function findManagerPage(managerName) {
  console.log(`🔍 البحث عن صفحة المدير: ${managerName}`);

  const response = await fetchAllDatabaseItems(MANAGERS_DB, {
    property: PROPERTY.managerTitle,
    title: { equals: managerName },
  });

  if (response.length > 0) {
    console.log(`✅ وُجدت صفحة المدير: ${managerName}`);
    return response[0].id;
  }

  console.log(`➕ لم تُوجد صفحة → سيتم الإنشاء من التيمبليت`);
  return null;
}

// --------------------------------------
// 5- Create manager page FROM TEMPLATE
// --------------------------------------
async function createManagerPageFromTemplate(managerName) {
  console.log(`📄 إنشاء صفحة للمدير: ${managerName}`);

  const newPage = await notion.pages.create({
    parent: {
      database_id: MANAGERS_DB,
    },
    properties: {
      [PROPERTY.managerTitle]: {
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

  await copyTemplateContent(TEMPLATE_PAGE_ID, newPage.id);

  console.log(`✅ تم إنشاء صفحة المدير: ${managerName}`);
  return newPage.id;
}

// --------------------------------------
// 6- Duplicate content inside template page (مع الأطفال)
// --------------------------------------
async function copyTemplateContent(templateId, newPageId) {
  const blocks = await fetchAllBlocks(templateId);

  if (!blocks.length) {
    console.log("⚠️ التيمبليت فارغ");
    return;
  }

  console.log(`📦 نسخ ${blocks.length} بلوك من التيمبليت...`);

  for (const block of blocks) {
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

  console.log("✅ تم نسخ محتوى التيمبليت.");
}

// --------------------------------------
// 7- Find "مشاريعك" database inside manager page
// --------------------------------------
async function findSubDatabase(managerPageId) {
  console.log(`🔍 البحث عن قاعدة ${SUB_DB_NAME} داخل صفحة المدير`);

  const children = await fetchAllBlocks(managerPageId);

  for (const block of children) {
    if (block.type === "child_database" && block.child_database.title === SUB_DB_NAME) {
      console.log(`✅ تم العثور على قاعدة ${SUB_DB_NAME}`);
      return block.id;
    }
  }

  console.log("❌ لم يتم العثور على القاعدة الفرعية.");
  return null;
}

// --------------------------------------
// 8- منع التكرار في قاعدة المدير
// --------------------------------------
async function projectExists(subDbId, projectName) {
  const matches = await fetchAllDatabaseItems(subDbId, {
    property: PROPERTY.projectName,
    title: { equals: projectName },
  });

  return matches.length > 0;
}

// --------------------------------------
// 9- Insert project into manager's "مشاريعك" DB
// --------------------------------------
async function insertProject(subDbId, project, projectName) {
  console.log(`➕ إضافة مشروع: ${projectName}`);

  await notion.pages.create({
    parent: { database_id: subDbId },
    properties: {
      [PROPERTY.projectName]: project.properties[PROPERTY.projectName],
      [PROPERTY.projectStatus]: project.properties[PROPERTY.projectStatus],
      [PROPERTY.projectRemaining]: project.properties[PROPERTY.projectRemaining],
      [PROPERTY.projectInvoices]: project.properties[PROPERTY.projectInvoices] || { files: [] },
      [PROPERTY.projectImage]: project.properties[PROPERTY.projectImage] || { files: [] },
    },
  });

  console.log("✅ تم الإضافة.");
}

// --------------------------------------
// 10- Main sync logic
// --------------------------------------
async function sync() {
  const summary = {
    processed: 0,
    created: 0,
    skippedNoManager: 0,
    skippedNoSubDb: 0,
    skippedDuplicate: 0,
    errors: 0,
  };

  const projects = await getAllProjects();

  for (const project of projects) {
    summary.processed += 1;
    const managerRelation = project.properties[PROPERTY.projectManager];

    if (!managerRelation || !managerRelation.relation.length) {
      console.log("⚠️ المشروع بلا مدير → تخطي");
      summary.skippedNoManager += 1;
      continue;
    }

    const managerName = (await resolveManagerName(managerRelation)) || "مدير";
    const projectName = project.properties[PROPERTY.projectName]?.title?.[0]?.plain_text || "مشروع";

    try {
      // 1) Find or Create Manager Page
      let managerPageId = await findManagerPage(managerName);

      if (!managerPageId) {
        managerPageId = await createManagerPageFromTemplate(managerName);
      }

      // 2) Find "مشاريعك" DB
      const subDbId = await findSubDatabase(managerPageId);
      if (!subDbId) {
        console.log(`❌ خطأ: قاعدة "${SUB_DB_NAME}" غير موجودة داخل صفحة المدير. أصلح التيمبليت.`);
        summary.skippedNoSubDb += 1;
        continue;
      }

      // 3) Prevent duplicates
      const exists = await projectExists(subDbId, projectName);
      if (exists) {
        console.log(`ℹ️ المشروع "${projectName}" موجود مسبقاً → تخطي`);
        summary.skippedDuplicate += 1;
        continue;
      }

      // 4) Insert project
      await insertProject(subDbId, project, projectName);
      summary.created += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`💥 خطأ أثناء مزامنة "${projectName}":`, err.message);
    }
  }

  console.log(
    `🎉 انتهت المزامنة. تمت معالجة ${summary.processed} مشروع | أضيف ${summary.created} | ` +
      `تخطي بلا مدير ${summary.skippedNoManager} | تخطي بلا قاعدة ${summary.skippedNoSubDb} | ` +
      `موجود مسبقاً ${summary.skippedDuplicate} | أخطاء ${summary.errors}`
  );
}

sync().catch((err) => {
  console.error("💥 Unhandled Error:", err);
});
