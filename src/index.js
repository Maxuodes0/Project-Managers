// src/index.js
// ================================
// Notion Projects → Managers Sync
// ================================

import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// -----------------------------
// 1. Environment & Notion Init
// -----------------------------

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROJECTS_DB = process.env.PROJECTS_DB;
const MANAGERS_DB = process.env.MANAGERS_DB;
const TEMPLATE_PAGE_ID = process.env.TEMPLATE_PAGE_ID;

function validateEnv() {
  const required = {
    NOTION_TOKEN,
    PROJECTS_DB,
    MANAGERS_DB,
    TEMPLATE_PAGE_ID,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error(
      `❌ خطأ في الإعدادات: المتغيرات البيئية التالية مفقودة: ${missing.join(
        ", "
      )}\nالرجاء التأكد من وجودها في ملف .env`
    );
    process.exit(1);
  }
}

validateEnv();

const notion = new Client({ auth: NOTION_TOKEN });

// -----------------------------
// 2. Helpers: Safe property get
// -----------------------------

function getPageTitle(page) {
  if (!page || !page.properties) return null;
  const titleKey = Object.keys(page.properties).find(
    (key) => page.properties[key].type === "title"
  );
  if (!titleKey) return null;
  const prop = page.properties[titleKey];
  if (!prop.title || prop.title.length === 0) return null;
  return prop.title.map((t) => t.plain_text).join("");
}

function getTitle(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop || prop.type !== "title" || !prop.title?.length) return null;
  return prop.title.map((t) => t.plain_text).join("");
}

function getSelectName(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop || prop.type !== "select" || !prop.select) return null;
  return prop.select.name || null;
}

function getFormulaNumber(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop || prop.type !== "formula") return null;
  const formula = prop.formula;
  if (!formula || formula.type !== "number") return null;
  return typeof formula.number === "number" ? formula.number : null;
}

function getRelationIds(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation))
    return [];
  return prop.relation.map((rel) => rel.id).filter(Boolean);
}

// -----------------------------
// 3. Fetch all projects
// -----------------------------

async function fetchAllProjectsFromDatabase(databaseId) {
  const pages = [];
  let cursor = undefined;

  console.log("📥 Fetching projects from PROJECTS_DB...");

  while (true) {
    const response = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
    });

    pages.push(...response.results);

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  console.log(`✅ Found ${pages.length} project(s) in PROJECTS_DB.`);
  return pages;
}

// -----------------------------
// 4. Template copy helpers
// -----------------------------

/**
 * Copy all content of TEMPLATE_PAGE_ID into manager page:
 * - For normal blocks: append as-is (cleaned)
 * - For child_database blocks: create new inline DB with same schema
 *   (properties) but WITHOUT views.
// */
async function copyTemplateToManagerPage(managerPageId) {
  console.log(`📦 Copying template into manager page ${managerPageId}...`);

  let cursor = undefined;

  while (true) {
    const response = await notion.blocks.children.list({
      block_id: TEMPLATE_PAGE_ID,
      page_size: 100,
      start_cursor: cursor,
    });

    // We'll accumulate non-database blocks in a batch,
    // and flush when we see a child_database (to preserve order as much as possible).
    let batch = [];

    const flushBatch = async () => {
      if (batch.length === 0) return;
      await notion.blocks.children.append({
        block_id: managerPageId,
        children: batch,
      });
      batch = [];
    };

    for (const block of response.results) {
      if (block.type === "child_database") {
        // Flush current batch of "normal" blocks
        await flushBatch();

        // Retrieve the template database schema
        const templateDbId = block.id;
        const templateDb = await notion.databases.retrieve({
          database_id: templateDbId,
        });

        // Create new inline database under the manager page
        await notion.databases.create({
          parent: { type: "page_id", page_id: managerPageId },
          title: templateDb.title,
          properties: templateDb.properties,
        });
      } else {
        // Strip out fields Notion doesn't want when creating blocks
        const { type, has_children } = block;
        const cleaned = {
          type,
          has_children,
          [type]: block[type],
        };
        batch.push(cleaned);
      }
    }

    // Flush remaining blocks in this page of results
    await flushBatch();

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  console.log(`✅ Template copied into manager page ${managerPageId}.`);
}

// -----------------------------
// 5. Find / ensure "مشاريعك" child DB
// -----------------------------

async function findProjectsChildDatabase(managerPageId) {
  let cursor = undefined;

  while (true) {
    const response = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of response.results) {
      if (
        block.type === "child_database" &&
        block.child_database?.title === "مشاريعك"
      ) {
        return block.id; // child_database id == database_id
      }
    }

    if (!response.has_more) break;
    cursor = response.next_cursor;
  }

  return null;
}

/**
 * Ensure that manager page has inline DB "مشاريعك".
 * If not found, copy template, then search again.
 */
async function ensureProjectsDatabase(managerPageId) {
  let dbId = await findProjectsChildDatabase(managerPageId);
  if (dbId) return dbId;

  console.log(
    `ℹ️ No "مشاريعك" database found in manager page ${managerPageId}, applying template...`
  );

  await copyTemplateToManagerPage(managerPageId);

  dbId = await findProjectsChildDatabase(managerPageId);

  if (!dbId) {
    console.error(
      `❌ ERROR: Still no "مشاريعك" child database found in manager page ${managerPageId} after applying template!`
    );
    return null;
  }

  return dbId;
}

// -----------------------------
// 6. Managers cache & helpers
// -----------------------------

/**
 * Cache structure by manager name:
 * {
 *   [managerName]: {
 *     managerPageId,
 *     projectsDbId
 *   }
 * }
 */
const managersCache = new Map();

/**
 * Get (or create) the manager page in MANAGERS_DB and ensure it has "مشاريعك" DB.
 * Uses cache to avoid repeated Notion calls.
 */
async function getOrCreateManagerTarget(originalManagerPageId, stats) {
  // Fetch original manager page (from relation)
  const originalPage = await notion.pages.retrieve({
    page_id: originalManagerPageId,
  });

  const managerName = getPageTitle(originalPage);
  if (!managerName) {
    throw new Error(
      `لا يمكن قراءة اسم المدير من صفحة المدير الأصلية (${originalManagerPageId})`
    );
  }

  // Check cache
  if (managersCache.has(managerName)) {
    return managersCache.get(managerName);
  }

  console.log(`👤 Processing manager: ${managerName}`);

  // Search for existing manager page in MANAGERS_DB
  const existing = await notion.databases.query({
    database_id: MANAGERS_DB,
    filter: {
      property: "اسم مدير المشروع",
      title: {
        equals: managerName,
      },
    },
  });

  let managerPageId;
  let isNewManager = false;

  if (existing.results.length > 0) {
    managerPageId = existing.results[0].id;
    console.log(`✅ Found existing manager page in MANAGERS_DB: ${managerPageId}`);
  } else {
    // Create new manager page
    const created = await notion.pages.create({
      parent: {
        database_id: MANAGERS_DB,
      },
      properties: {
        "اسم مدير المشروع": {
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

    managerPageId = created.id;
    isNewManager = true;
    stats.newManagerPages++;
    console.log(
      `➕ Created new manager page in MANAGERS_DB: ${managerPageId} for ${managerName}`
    );

    // Copy template content into this new page
    await copyTemplateToManagerPage(managerPageId);
  }

  // Ensure "مشاريعك" database exists
  const projectsDbId = await ensureProjectsDatabase(managerPageId);
  if (!projectsDbId) {
    throw new Error(
      `لا يمكن المتابعة مع المدير "${managerName}" لأن داتابيس "مشاريعك" غير موجود.`
    );
  }

  const cacheValue = { managerPageId, projectsDbId, managerName };
  managersCache.set(managerName, cacheValue);
  return cacheValue;
}

// -----------------------------
// 7. Upsert project into manager's "مشاريعك" DB
// -----------------------------

async function upsertProjectForManager({
  managerProjectsDbId,
  projectName,
  projectStatus,
  remainingAmount,
  stats,
}) {
  // Find existing project by "اسم المشروع"
  const existing = await notion.databases.query({
    database_id: managerProjectsDbId,
    filter: {
      property: "اسم المشروع",
      title: {
        equals: projectName,
      },
    },
  });

  const propertiesPayload = {
    "اسم المشروع": {
      title: [
        {
          text: {
            content: projectName,
          },
        },
      ],
    },
  };

  if (projectStatus) {
    propertiesPayload["حالة المشروع"] = {
      select: {
        name: projectStatus,
      },
    };
  }

  if (typeof remainingAmount === "number" && !Number.isNaN(remainingAmount)) {
    propertiesPayload["المبلغ المتبقي"] = {
      number: remainingAmount,
    };
  }

  if (existing.results.length > 0) {
    // Update existing
    const pageId = existing.results[0].id;

    await notion.pages.update({
      page_id: pageId,
      properties: propertiesPayload,
    });

    stats.projectsUpdated++;
    console.log(
      `♻️ Updated project "${projectName}" in manager DB ${managerProjectsDbId}`
    );
  } else {
    // Create new
    await notion.pages.create({
      parent: {
        database_id: managerProjectsDbId,
      },
      properties: propertiesPayload,
    });

    stats.projectsInserted++;
    console.log(
      `🆕 Created project "${projectName}" in manager DB ${managerProjectsDbId}`
    );
  }
}

// -----------------------------
// 8. Per-project processing
// -----------------------------

async function processProjectPage(projectPage, stats) {
  const projectName = getTitle(projectPage, "اسم المشروع");
  const projectStatus = getSelectName(projectPage, "حالة المشروع");
  const remainingAmount = getFormulaNumber(projectPage, "المبلغ المتبقي");
  const managerRelationIds = getRelationIds(projectPage, "مدير المشروع");

  stats.totalProjectsProcessed++;

  if (!projectName) {
    console.warn(
      `⚠️ تم تخطي مشروع بدون "اسم المشروع" واضح (page_id: ${projectPage.id}).`
    );
    return;
  }

  if (!managerRelationIds.length) {
    console.warn(
      `⚠️ تم تخطي مشروع "${projectName}" لأنه لا يحتوي على علاقة "مدير المشروع".`
    );
    return;
  }

  console.log(
    `\n==============================\n📂 Project: ${projectName}\n==============================`
  );

  for (const managerRelId of managerRelationIds) {
    try {
      const { managerPageId, projectsDbId, managerName } =
        await getOrCreateManagerTarget(managerRelId, stats);

      console.log(
        `→ Syncing project "${projectName}" for manager "${managerName}" (projects DB: ${projectsDbId})`
      );

      await upsertProjectForManager({
        managerProjectsDbId: projectsDbId,
        projectName,
        projectStatus,
        remainingAmount,
        stats,
      });
    } catch (err) {
      console.error(
        `❌ ERROR while processing manager relation ${managerRelId} for project "${projectName}": ${err.message}`
      );
      // Continue to next manager relation
      continue;
    }
  }
}

// -----------------------------
// 9. Main
// -----------------------------

async function main() {
  const stats = {
    totalProjectsProcessed: 0,
    projectsInserted: 0,
    projectsUpdated: 0,
    newManagerPages: 0,
  };

  try {
    const projects = await fetchAllProjectsFromDatabase(PROJECTS_DB);

    for (const projectPage of projects) {
      try {
        await processProjectPage(projectPage, stats);
      } catch (err) {
        console.error(
          `❌ ERROR while processing project page ${projectPage.id}: ${err.message}`
        );
        // Don't stop the whole script; continue with next project
        continue;
      }
    }
  } catch (err) {
    console.error(`❌ Fatal error in main(): ${err.message}`);
  } finally {
    console.log("\n==============================");
    console.log("📊 Sync statistics:");
    console.log(
      `- Total projects processed: ${stats.totalProjectsProcessed}`
    );
    console.log(`- Projects inserted:        ${stats.projectsInserted}`);
    console.log(`- Projects updated:         ${stats.projectsUpdated}`);
    console.log(`- New manager pages:        ${stats.newManagerPages}`);
    console.log("==============================\n");
  }
}

main();
