import { Client } from "@notionhq/client";
import "dotenv/config";

// ثابت لاسم الداتابيس الفرعية داخل صفحة المدير
const CHILD_DB_TITLE = "مشاريعك";

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
 * تلاقي صفحة مدير في داتا بيس "مدراء المشاريع"
 * تعتمد على الحقل: "اسم مدير المشروع" كـ title
 * ما عاد ننشئ صفحة جديدة، لو مافيه → نحذر ونعدّي
 */
async function findManagerPage(managerName) {
  if (managerPageCache.has(managerName)) {
    return managerPageCache.get(managerName);
  }

  console.log(`\n🔎 Looking for manager page in "مدراء المشاريع": ${managerName}`);

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

  console.warn(
    `⚠️ No manager page found in "مدراء المشاريع" for "${managerName}".` +
      ` Make sure you created it using your template.`
  );
  return null;
}

/**
 * تلاقي داتا بيس "مشاريعك" داخل صفحة المدير
 * نبحث عن child_database عنوانه CHILD_DB_TITLE
 * لو ما لقينا → ما ننشئ، بس نحذر
 */
async function findChildProjectsDatabase(managerPageId) {
  if (managerChildDbCache.has(managerPageId)) {
    return managerChildDbCache.get(managerPageId);
  }

  console.log(
    `   🔍 Looking for child database "${CHILD_DB_TITLE}" under manager page: ${managerPageId}`
  );

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
        const title = block.child_database.title;
        console.log(`   • Found child_database block with title: "${title}"`);
        if (title === CHILD_DB_TITLE) {
          found = {
            id: block.id,
            title,
          };
          break;
        }
      }
    }

    if (found || !children.has_more) break;
    cursor = children.next_cursor;
  } while (cursor);

  if (!found) {
    console.warn(
      `   ⚠️ No child_database titled "${CHILD_DB_TITLE}" found under manager page ${managerPageId}.` +
        ` Make sure your template adds this database inside the manager page.`
    );
    return null;
  }

  console.log(
    `   ✅ Using child database "${found.title}" (ID: ${found.id}) under manager page (${managerPageId})`
  );
  managerChildDbCache.set(managerPageId, found);
  return found;
}

/**
 * تلاقي أو تحدّث صف مشروع داخل داتا بيس "مشاريعك" الخاصة بالمدير
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
 *   - تلاقي صفحة في "مدراء المشاريع" (موجودة مسبقًا من التيمبليت)
 *   - تلاقي داتا بيس "مشاريعك" داخل الصفحة (موجودة مسبقًا من التيمبليت)
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

        // 1) نلقى صفحة في داتا بيس "مدراء المشاريع" (لا ننشئ جديدة)
        const managerPageId = await findManagerPage(managerName);
        if (!managerPageId) {
          console.log(
            `   ⚠️ Manager page not found for "${managerName}", skipping this manager.`
          );
          continue;
        }

        // 2) نلقى داتا بيس "مشاريعك" داخل صفحة المدير (لا ننشئ جديدة)
        const childDb = await findChildProjectsDatabase(managerPageId);
        if (!childDb) {
          console.log(
            `   ⚠️ Child database "${CHILD_DB_TITLE}" not found under manager "${managerName}", skipping.`
          );
          continue;
        }

        // 3) نضيف/نحدّث صف المشروع في داتا بيس "مشاريعك"
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
