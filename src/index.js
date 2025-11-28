import { Client } from "@notionhq/client";
import "dotenv/config";

// نقرأ المتغيرات من الـ Environment (تيجي من GitHub Secrets)
const notionToken = process.env.NOTION_TOKEN;
const projectsDbId = process.env.PROJECTS_DB;
const managersDbId = process.env.MANAGERS_DB;
const subDbName = process.env.SUB_DB_NAME; // اسم الداتابيس الفرعية داخل صفحة كل مدير (اختياري)

if (!notionToken) {
  console.error("❌ NOTION_TOKEN is missing. Please set it in GitHub Secrets.");
  process.exit(1);
}

// إنشاء كلاينت نوشن
const notion = new Client({ auth: notionToken });

/**
 * دالة تطبع كل الحقول (properties) لأي داتا بيس
 */
async function logDatabaseSchema(databaseId, label) {
  if (!databaseId) {
    console.warn(`⚠️ ${label}: database id is missing, skipping.`);
    return;
  }

  console.log("\n======================================");
  console.log(`📚 Database: ${label}`);
  console.log(`ID: ${databaseId}`);
  console.log("======================================");

  const db = await notion.databases.retrieve({ database_id: databaseId });

  const dbName =
    (db.title && db.title[0] && db.title[0].plain_text) || "(no title)";
  console.log(`Name in Notion: ${dbName}`);
  console.log("Fields / Properties:");

  const props = db.properties || {};
  for (const [name, def] of Object.entries(props)) {
    const type = def.type;
    console.log(`  - ${name} (${type})`);
  }
}

/**
 * دالة تحاول تجيب عنوان الصفحة من أي حقل نوعه title
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
 * دالة تمر على داتا بيس مدراء المشاريع
 * وتدخل على صفحة كل مدير
 * وتدور على أي child database داخل الصفحة
 * وتطبع الحقول حقها
 */
async function logSubDatabasesForManagers() {
  if (!managersDbId) {
    console.warn("⚠️ MANAGERS_DB is missing. Skipping sub-databases.");
    return;
  }

  console.log("\n======================================");
  console.log("🔍 Scanning manager pages for sub-databases...");
  console.log(
    `Target sub DB name (SUB_DB_NAME): ${
      subDbName || "no filter (will log ALL child databases)"
    }`
  );
  console.log("======================================");

  let cursor;
  do {
    const response = await notion.databases.query({
      database_id: managersDbId,
      page_size: 50,
      start_cursor: cursor,
    });

    for (const page of response.results) {
      const pageId = page.id;
      const managerName = getPageTitle(page);

      console.log(
        `\n👤 Manager page: ${managerName} (${pageId}) - checking children blocks...`
      );

      let childCursor;
      let foundAnyChildDb = false;

      do {
        const children = await notion.blocks.children.list({
          block_id: pageId,
          page_size: 50,
          start_cursor: childCursor,
        });

        for (const block of children.results) {
          console.log(`  • Child block type: ${block.type}`);

          if (block.type === "child_database") {
            foundAnyChildDb = true;
            const childTitle = block.child_database.title;
            const childDbId = block.id; // نفس الـ ID يستخدم كـ database_id

            console.log(
              `    → Found child database: "${childTitle}" (ID: ${childDbId})`
            );

            // لو SUB_DB_NAME فاضي -> نطبع كل الداتابيس
            // لو فيه قيمة -> نفلتر عليها
            if (!subDbName || childTitle === subDbName) {
              const label = `Sub DB "${childTitle}" under manager "${managerName}"`;
              await logDatabaseSchema(childDbId, label);
            }
          }
        }

        childCursor = children.has_more ? children.next_cursor : undefined;
      } while (childCursor);

      if (!foundAnyChildDb) {
        console.log("  (no child databases found in this page)");
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);
}

/**
 * الدالة الرئيسية
 */
async function main() {
  try {
    // 1) داتا بيس المشاريع
    await logDatabaseSchema(projectsDbId, "Projects DB (المشاريع)");

    // 2) داتا بيس مدراء المشاريع
    await logDatabaseSchema(managersDbId, "Managers DB (مدراء المشاريع)");

    // 3) كل الداتا بيسات الفرعية داخل صفحات مدراء المشاريع
    await logSubDatabasesForManagers();

    console.log("\n✅ Finished listing schemas for all databases.");
  } catch (error) {
    console.error("❌ Error while listing database schemas:");
    console.error(error);
    process.exit(1);
  }
}

// تشغيل
main();
