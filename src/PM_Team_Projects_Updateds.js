// src/PM_Team_Projects_Updateds.js
import dotenv from "dotenv";
import { Client } from "@notionhq/client";

dotenv.config();

// ---------------------------------------------------------
// ENV
// ---------------------------------------------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const MANAGERS_DB = process.env.MANAGERS_DB;
const PROJECTS_DB = process.env.PROJECTS_DB;
const FREELANCERS_DB = process.env.FREELANCERS;

if (!NOTION_TOKEN || !MANAGERS_DB || !PROJECTS_DB || !FREELANCERS_DB) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// ---------------------------------------------------------
// HELPERS
// ---------------------------------------------------------
async function listAllPages(databaseId) {
  const results = [];
  let cursor;

  while (true) {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });

    results.push(...res.results);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  return results;
}

function getTitle(page, prop) {
  return page.properties[prop]?.title?.map((t) => t.plain_text).join("") || null;
}

function getSelect(page, prop) {
  return page.properties[prop]?.select?.name || null;
}

// ✅ NEW: Rich text reader (for IBAN fields)
function getRichText(page, prop) {
  const rt = page.properties?.[prop]?.rich_text;
  if (!Array.isArray(rt)) return null;
  const v = rt.map((t) => t.plain_text).join("").trim();
  return v || null;
}

// ✅ NEW: Relation IDs reader
function getRelationIds(page, prop) {
  const rel = page.properties?.[prop]?.relation;
  if (!Array.isArray(rel)) return [];
  return rel.map((r) => r.id).filter(Boolean);
}

// ✅ NEW: Rich text setter
function setRichText(value) {
  return { rich_text: [{ type: "text", text: { content: value } }] };
}

// ---------------------------------------------------------
// IBAN AUTO-SYNC CONFIG (from FREELANCERS_DB -> Team DB)
// ---------------------------------------------------------
const FREELANCER_IBAN_PROP = "ايبان البنك"; // in FREELANCERS_DB (Rich text)
const TEAM_IBAN_PROP = "آيبان"; // in "فريق الفري لانس" (Rich text)
const TEAM_FREELANCER_REL_PROP = "اسم الفريلانسر"; // Relation in team DB

// Cache to reduce Notion API calls
const freelancerIbanCache = new Map(); // key: freelancerPageId, value: iban string|null

async function getFreelancerIban(freelancerPageId) {
  if (freelancerIbanCache.has(freelancerPageId)) {
    return freelancerIbanCache.get(freelancerPageId);
  }

  const pg = await notion.pages.retrieve({ page_id: freelancerPageId });
  const iban = getRichText(pg, FREELANCER_IBAN_PROP);
  freelancerIbanCache.set(freelancerPageId, iban);
  return iban;
}

// Sync IBAN into each row of the team freelance DB
async function syncIbanIntoFreelanceRows(freelanceDbId) {
  const rows = await listAllPages(freelanceDbId);

  for (const row of rows) {
    const freelancerIds = getRelationIds(row, TEAM_FREELANCER_REL_PROP);
    if (!freelancerIds.length) continue;

    // If multiple freelancers are linked, take the first one
    const freelancerId = freelancerIds[0];

    const ibanFromFreelancer = await getFreelancerIban(freelancerId);
    if (!ibanFromFreelancer) continue;

    const currentIban = getRichText(row, TEAM_IBAN_PROP);

    // No update if identical
    if (currentIban === ibanFromFreelancer) continue;

    await notion.pages.update({
      page_id: row.id,
      properties: {
        [TEAM_IBAN_PROP]: setRichText(ibanFromFreelancer),
      },
    });

    console.log(`🏦 Synced IBAN for row ${row.id}`);
  }
}

// ---------------------------------------------------------
// ENSURE CHILD DATABASE EXISTS
// ---------------------------------------------------------
async function ensureChildDatabase(pageId, title, properties) {
  const blocks = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 100,
  });

  const exists = blocks.results.find(
    (b) => b.type === "child_database" && b.child_database?.title === title
  );

  if (exists) return exists.id;

  const created = await notion.databases.create({
    parent: { type: "page_id", page_id: pageId },
    title: [{ type: "text", text: { content: title } }],
    is_inline: true,
    properties,
  });

  console.log(`✅ Created DB "${title}"`);
  return created.id;
}

// ---------------------------------------------------------
// SCHEMAS
// ---------------------------------------------------------
const FREELANCE_SCHEMA = {
  "اسم الفريلانسر": {
    relation: {
      database_id: FREELANCERS_DB,
      single_property: {},
    },
  },

  "ملاحطات": { title: {} },

  "نوع الصرف": {
    select: {
      options: [
        { name: "كاش", color: "green" },
        { name: "تحويل", color: "yellow" },
      ],
    },
  },

  "الدور في المشروع": {
    select: {
      options: [
        { name: "فوتو – Photography", color: "blue" },
        { name: "فيديو – Video", color: "green" },
        { name: "مونتير – Video Editing", color: "yellow" },
        { name: "DIT – Digital Imaging Technician", color: "gray" },
        { name: "هايبر لابس – Hyperlapse", color: "purple" },
        { name: "تايم لابس – Timelapse", color: "pink" },
        { name: "ترجمة – Translation", color: "brown" },
        { name: "فويس أوفر – Voice Over", color: "orange" },
        { name: "درون – Drone", color: "red" },
        { name: "FPV – FPV Drone", color: "default" },
        { name: "فيديو & مونتير – Video & Editing", color: "green" },
        { name: "محرر صور – Photo Editor", color: "blue" },
        { name: "جرافيكس – Graphics", color: "purple" },
        { name: "تصميم – Design", color: "pink" },
        { name: "سيناريو – Script / Scriptwriting", color: "yellow" },
        { name: "مساعد – Assistant", color: "gray" },
      ],
    },
  },

  "المبلغ": { number: { format: "number" } },

  // ✅ will be auto-filled by syncIbanIntoFreelanceRows() from FREELANCERS_DB -> "ايبان البنك"
  "آيبان": { rich_text: {} },

  "حالة الدفع": {
    select: {
      options: [
        { name: "مكتمل", color: "green" },
        { name: "جزئي", color: "yellow" },
        { name: "غير مدفوع", color: "red" },
      ],
    },
  },

  "إيصال": { files: {} },
};

const PURCHASES_SCHEMA = {
  "نوع المصروف": { title: {} },

  "تاريخ": { date: {} },

  "المبلغ": { number: { format: "number" } },

  "المبلغ بدون ضريبة": { number: { format: "number" } },

  "إرفاق الفاتورة": { files: {} },

  "دافع المبلغ": {
    select: {
      options: [
        { name: "الشركة", color: "blue" },
        { name: "المدير", color: "gray" },
      ],
    },
  },
};

// ---------------------------------------------------------
// UPDATE PROJECT STATUS IN MAIN DB
// ---------------------------------------------------------
async function updateMainProjectStatus(projectPage) {
  const projectName = getTitle(projectPage, "اسم المشروع");
  const statusFromManager = getSelect(projectPage, "حالة المشروع");
  const source = getSelect(projectPage, "آخر مصدر تحديث");

  if (!projectName || !statusFromManager) return;
  if (source !== "مدير المشروع") return;

  const res = await notion.databases.query({
    database_id: PROJECTS_DB,
    filter: {
      property: "اسم المشروع",
      title: { equals: projectName },
    },
    page_size: 1,
  });

  if (!res.results.length) return;

  const page = res.results[0];
  const currentStatus = getSelect(page, "حالة المشروع");

  if (currentStatus === statusFromManager) return;

  await notion.pages.update({
    page_id: page.id,
    properties: {
      "حالة المشروع": {
        select: { name: statusFromManager },
      },
    },
  });

  await notion.pages.update({
    page_id: projectPage.id,
    properties: {
      "آخر مصدر تحديث": {
        select: { name: "النظام" },
      },
    },
  });

  console.log(`🔄 Updated project "${projectName}" → ${statusFromManager}`);
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
  console.log("🚀 Starting PM_Team_Projects_Updateds");

  const managers = await listAllPages(MANAGERS_DB);

  for (const manager of managers) {
    const managerPageId = manager.id;

    const blocks = await notion.blocks.children.list({
      block_id: managerPageId,
      page_size: 100,
    });

    const projectsDbBlock = blocks.results.find(
      (b) => b.type === "child_database" && b.child_database?.title === "مشاريعك"
    );

    if (!projectsDbBlock) continue;

    const projects = await listAllPages(projectsDbBlock.id);

    for (const project of projects) {
      // ✅ Ensure "فريق الفري لانس" exists and get its DB id
      const freelanceDbId = await ensureChildDatabase(
        project.id,
        "فريق الفري لانس",
        FREELANCE_SCHEMA
      );

      // ✅ Sync IBAN from FREELANCERS_DB ("ايبان البنك") into team DB field "آيبان"
      await syncIbanIntoFreelanceRows(freelanceDbId);

      // ✅ Ensure "المشتريات" exists
      await ensureChildDatabase(project.id, "المشتريات", PURCHASES_SCHEMA);

      // ✅ Sync project status (manager -> main)
      await updateMainProjectStatus(project);
    }
  }

  console.log("✅ PM_Team_Projects_Updateds finished");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
