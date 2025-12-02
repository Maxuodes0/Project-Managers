async function createProjectsDbFromTemplate(managerPageId) {
  console.log("📦 Creating INLINE Projects DB…");

  // 1) جلب child_database من التيمبليت
  const blocks = await notion.blocks.children.list({
    block_id: TEMPLATE_PAGE_ID,
    page_size: 100,
  });

  const dbBlock = blocks.results.find(
    (b) => b.type === "child_database" && b.child_database?.title === "مشاريعك"
  );

  if (!dbBlock) throw new Error("❌ Template missing 'مشاريعك' database.");

  const templateDb = await notion.databases.retrieve({
    database_id: dbBlock.id,
  });

  // 2) أنشئ block child_database داخل صفحة المدير
  const newBlock = await notion.blocks.children.append({
    block_id: managerPageId,
    children: [
      {
        type: "child_database",
        child_database: {
          title: "مشاريعك",
        },
      },
    ],
  });

  const newDbId = newBlock.results[0].id;

  // 3) حدّث السكيمة (properties) للداتابيس الجديد
  await notion.databases.update({
    database_id: newDbId,
    title: [
      {
        type: "text",
        text: { content: "مشاريعك" },
      },
    ],
    properties: templateDb.properties,
  });

  console.log("✅ INLINE Projects DB created:", newDbId);

  return newDbId;
}
