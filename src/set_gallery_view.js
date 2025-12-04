// set_gallery_view.js
import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// ---------------------------------------------------------
// ENV
// ---------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const MANAGERS_DB = process.env.MANAGERS_DB;

if (!NOTION_TOKEN || !MANAGERS_DB) {
    console.error("❌ Missing required ENV: NOTION_TOKEN or MANAGERS_DB");
    process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------

// جلب اسم الصفحة (المدير)
function getPageTitle(pg) {
  const key = Object.keys(pg.properties).find(
    k => pg.properties[k].type === "title"
  );
  return pg.properties[key]?.title?.map(t => t.plain_text).join("") || "Unknown Manager";
}

// ---------------------------------------------------------
// FETCH DB ID FOR MANAGER
// ---------------------------------------------------------

// تبحث عن قاعدة البيانات المضمنة "مشاريعك" داخل صفحة المدير
async function findInlineProjectsDB(managerPageId) {
    let cursor;
    while (true) {
        const r = await notion.blocks.children.list({
            block_id: managerPageId,
            page_size: 100,
            start_cursor: cursor,
        });

        for (const b of r.results) {
            // التحقق من أنها قاعدة بيانات مضمنة بالاسم الصحيح
            if (b.type === "child_database" && b.child_database?.title === "مشاريعك") {
                return b.id; // معرّف قاعدة البيانات المضمنة
            }
        }

        if (!r.has_more) break;
        cursor = r.next_cursor;
    }
    return null;
}

// ---------------------------------------------------------
// UPDATE DB VIEW TO GALLERY
// ---------------------------------------------------------

async function setGalleryLayout(dbId, managerName) {
    try {
        await notion.databases.update({
            database_id: dbId,
            // 👈 هذا هو التعديل الأساسي لتغيير الـ Layout
            layout: {
                type: "gallery",
                gallery: {
                    cover: {
                        type: "page_cover",
                    },
                    card_size: "medium"
                }
            },
            // 👈 هذا يغير اسم العرض الافتراضي إلى "Gallery"
            default_view_id: null, // تأكد من تعيينه إلى null أولاً إذا لزم الأمر
            title: [
                {
                    type: "text",
                    text: { content: "مشاريعك" },
                },
            ],
            
        });
        console.log(`✅ Success: Updated ${managerName}'s DB (${dbId}) to Gallery View.`);
    } catch (error) {
        console.error(`❌ Error updating ${managerName}'s DB (${dbId}):`, error.message);
    }
}


// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
    console.log("--- STARTING GALLERY VIEW SETUP ---");

    // 1. جلب جميع صفحات المديرين من MANAGERS_DB
    const managers = await notion.databases.query({
        database_id: MANAGERS_DB,
        page_size: 100, // يمكن زيادتها إذا كان عدد المديرين كبيراً
    });

    for (const managerPage of managers.results) {
        const managerName = getPageTitle(managerPage);
        const managerPageId = managerPage.id;

        console.log(`\n👤 Processing Manager: ${managerName}`);
        
        // 2. البحث عن معرّف قاعدة البيانات المضمنة
        const projectsDbId = await findInlineProjectsDB(managerPageId);

        if (projectsDbId) {
            console.log(`   Found Projects DB ID: ${projectsDbId}`);
            
            // 3. تطبيق تنسيق Gallery View على القاعدة
            await setGalleryLayout(projectsDbId, managerName);
        } else {
            console.log("   ⚠️ Warning: Could not find 'مشاريعك' inline DB. It may need to be created by index.js first.");
        }
    }

    console.log("\n--- GALLERY VIEW SETUP COMPLETE ---");
}

main();
