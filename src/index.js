import { Client } from "@notionhq/client";
import "dotenv/config";

// نقرأ المتغيرات من الـ Environment (تيجي من GitHub Secrets)
const notionToken = process.env.NOTION_TOKEN;
const projectsDbId = process.env.PROJECTS_DB;
const managersDbId = process.env.MANAGERS_DB;

if (!notionToken) {
  console.error("❌ NOTION_TOKEN is missing. Please set it in GitHub Secrets.");
  process.exit(1);
}
if (!projectsDbId) {
  console.error("❌ PROJECTS_DB is missing. Please set it in GitHub Secrets.");
  process.exit(1);
}
if (!managersDbId) {
  console.error("❌ MANAGERS_DB is missing. Please set it in GitHub Secrets.");
  process.exit(1);
}

// إنشاء كلاينت نوشن
const notion = new Client({ auth: notionToken });

// كاش بسيط عشان ما نعيد نفس الكويري مليون مرة
const managerPageCache = new Map(); // managerName -> managerPageId
const managerChildDbCache = new Map(); // managerPageId -> { id, title }

/**
 * دالة تحاول تجيب عنوان أي صفحة من أول حقل title
 */
function getPageTitle(page) {
  const props = page.properties || {};
  for (const [, propValue] of Object.entries(props)) {
    if (propValue.type === "title") {
      const t = propValue.title?.[0]?.plain_text;
      if (t) return t;
    }
  }
  return page.id;
}

/**
 * تلاقي أو تنشئ صفحة مدير في داتا بيس "مدراء المشاريع"
 * تعتمد على الحقل: "اسم مدير المشروع" كـ title
 */
async function findOrCreateManagerPage(managerName) {
  if (managerPageCache.has(managerName)) {
    return managerPageCache.get(managerName);
  }

  console.log(`\n🔎 Looking for manager page in "مدراء المشاريع": ${managerName}`);

  // نحاول نلقاها
  const search = await notion.databases.query({
    database_id: managersDbId,
    filter: {
      property: "اسم مدير المشروع",
      title: {
        equals: managerName,
      },
    },
    page_size: 1,
  });

  if (search.results.length > 0) {
    const existingPage = search.results[0];
    const pageId = existingPage.id;
    console.log(`✅ Found existing manager page: ${managerName} (${pageId})`);
    managerPageCache.set(managerName, pageId);
    return pageId;
  }

  // ما لقينا، ننشئ صفحة جديدة
  console.log(`➕ Creating new manager page: ${managerName}`);
  const newPage = await notion.pages.create({
    parent: { database_id: managersDbId },
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

  const newId = newPage.id;
  console.log(`✅ Created manager page: ${managerName} (${newId})`);
  managerPageCache.set(managerName, newId);
  return newId;
}

/**
 * لو ما فيه child_database داخل صفحة المدير، ننشئ وحدة جديدة
 */
async function createChildProjectsDatabase(managerPageId) {
  console.log(
    `   ➕ Creating new child database "مشاريعك" under manager page: ${managerPageId}`
  );

  const db = await notion.databases.create({
    parent: { page_id: managerPageId },
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: {
      "اسم المشروع": {
        title: {},
      },
      "حالة المشروع": {
        select: {
          options: [],
        },
      },
      "المتبقي": {
        number: {},
      },
    },
  });

  const child = {
    id: db.id,
    title: "مشاريعك",
  };

  console.log(
    `   ✅ Created child database "مشاريعك" (ID: ${child.id}) under manager page ${managerPageId}`
  );

  return child;
}

/**
 * تلاقي أول child_database داخل صفحة المدير
 * لو ما لقت → تنشئ داتا بيس "مشاريعك" جديدة
 */
async function findOrCreateChildProjectsDatabase(managerPageId) {
  if (managerChildDbCache.has(managerPageId)) {
    return managerChildDbCache.get(managerPageId);
  }

  console.log(`   🔍 Looking for child database under manager page: ${managerPageId}`);

  let cursor;
  let found = null;

  do {
    const children = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const block of children.results) {
      if (block.type === "child_database") {
        found = {
          id: block.id,
          title: block.child_database.title,
        };
        break;
      }
    }

    if (found || !children.has_more) break;
    cursor = children.next_cursor;
  } while (cursor);

  if (!found) {
    console.warn(
      `   ⚠️ No child_database found under manager page ${managerPageId}. Will create one.`
    );
    found = await createChildProjectsDatabase(managerPageId);
  } else {
    console.log(
      `   ✅ Found child database "${found.title}" under manager page (${managerPageId})`
    );
  }

  managerChildDbCache.set(managerPageId, found);
  return found;
}

/**
 * تلاقي أو تنشئ صف مشروع داخل داتا بيس "مشاريعك" الخاصة بالمدير
 * - نعتمد على عنوان المشروع "اسم المشروع" كـ مفتاح
 * - نحدّث حالة المشروع والمتبقي
 */
async function upsertProjectInManagerDb({
  managerName,
  childDb,
  projectName,
  projectStatus,
  projectRemaining,
}) {
  const childDbId = childDb.id;

  console.log(
    `   🔁 Sync project "${projectName}" for manager "${managerName}" in sub DB "${childDb.title}"`
  );

  // نشوف إذا فيه صف موجود بنفس اسم المشروع
  const search = await notion.databases.query({
    database_id: childDbId,
    filter: {
      property: "اسم المشروع",
      title: {
        equals: projectName,
      },
    },
    page_size: 1,
  });

  const propsToSet = {
    "اسم المشروع": {
      title: [
        {
          type: "text",
          text: { content: projectName },
        },
      ],
    },
  };

  if (projectStatus) {
    propsToSet["حالة المشروع"] = {
      select: {
        name: projectStatus,
      },
    };
  }

  if (typeof projectRemaining === "number") {
    propsToSet["المتبقي"] = {
      number: projectRemaining,
    };
  }

  if (search.results.length > 0) {
    // نحدّث الموجود
    const existingPage = search.results[0];
    console.log(
      `   ✏️ Updating existing project row in "${childDb.title}" for "${projectName}"`
    );
    await notion.pages.update({
      page_id: existingPage.id,
      properties: propsToSet,
    });
  } else {
    // ننشئ صف جديد
    console.log(
      `   ➕ Creating new project row in "${childDb.title}" for "${projectName}"`
    );
    await notion.pages.create({
      parent: { database_id: childDbId },
      properties: propsToSet,
    });
  }
}

/**
 * الوظيفة الرئيسية:
 * - تمر على كل المشاريع في داتا بيس "المشاريع"
 * - لكل مشروع تجيب المدير/المدراء من حقل "مدير المشروع" (relation)
 * - لكل مدير:
 *   - تلاقي/تنشئ صفحة في "مدراء المشاريع"
 *   - تلاقي/تنشئ داتا بيس "مشاريعك" داخل الصفحة
 *   - تضيف/تحدّث صف المشروع فيها
 */
async function syncProjectsToManagers() {
  console.log("🚀 Starting sync from 'المشاريع' to 'مدراء المشاريع' + 'مشاريعك'...");

  let cursor;
  let projectCount = 0;

  do {
    const response = await notion.databases.query({
      database_id: projectsDbId,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      projectCount += 1;

      const projectId = page.id;
      const projectName =
        page.properties?.["اسم المشروع"]?.title?.[0]?.plain_text || projectId;

      const statusObj = page.properties?.["حالة المشروع"]?.select || null;
      const projectStatus = statusObj?.name || null;

      const remainingFormula = page.properties?.["المبلغ المتبقي"]?.formula || null;
      const projectRemaining =
        typeof remainingFormula?.number === "number"
          ? remainingFormula.number
          : null;

      const managersRelation = page.properties?.["مدير المشروع"]?.relation || [];

      console.log(
        `\n📌 Project: ${projectName} (${projectId}) | Status: ${
          projectStatus || "N/A"
        } | Remaining: ${
          typeof projectRemaining === "number" ? projectRemaining : "N/A"
        }`
      );

      if (!managersRelation.length) {
        console.log("   ⚠️ No managers linked in 'مدير المشروع', skipping.");
        continue;
      }

      for (const rel of managersRelation) {
        const managerRelPageId = rel.id;

        // نجيب صفحة الموظف اللي هو المدير من الريليشن (غالبًا من داتا بيس الموظفين)
        const managerRelPage = await notion.pages.retrieve({
          page_id: managerRelPageId,
        });
        const managerName = getPageTitle(managerRelPage);

        console.log(
          `   👤 Handling manager from relation: ${managerName} (${managerRelPageId})`
        );

        // 1) تلاقي أو تنشئ صفحة في داتا بيس "مدراء المشاريع"
        const managerPageId = await findOrCreateManagerPage(managerName);

        // 2) تلاقي أو تنشئ child database (مشاريعك) داخل صفحة المدير
        const childDb = await findOrCreateChildProjectsDatabase(managerPageId);
        if (!childDb) {
          console.log(
            `   ⚠️ Could not get or create child database under manager "${managerName}", skipping.`
          );
          continue;
        }

        // 3) تضيف/تحدّث صف المشروع في داتا بيس "مشاريعك"
        await upsertProjectInManagerDb({
          managerName,
          childDb,
          projectName,
          projectStatus,
          projectRemaining,
        });
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`\n✅ Sync completed. Total projects processed: ${projectCount}`);
}

/**
 * الدالة الرئيسية
 */
async function main() {
  try {
    await syncProjectsToManagers();
  } catch (error) {
    console.error("❌ Error during sync:");
    console.error(error);
    process.exit(1);
  }
}

// تشغيل
main();
