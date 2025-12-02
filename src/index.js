from notion_client import Client
from config import NOTION_TOKEN, PROJECTS_DB_ID, MANAGERS_DB_ID, TEMPLATE_PAGE_ID
from helpers import (
    get_property_value, find_child_database_id, transform_template_blocks
)

class ProjectProcessor:
    def __init__(self, notion_token, projects_db_id, managers_db_id, template_page_id):
        self.notion = Client(auth=notion_token)
        self.projects_db_id = projects_db_id
        self.managers_db_id = managers_db_id
        self.template_page_id = template_page_id
        
        # Caching لصفحات المديرين: {manager_name: manager_page_id}
        self.manager_cache = {}
        
        # Statistics
        self.stats = {
            "processed_projects": 0,
            "added_projects": 0,
            "updated_projects": 0,
            "new_manager_pages": 0,
            "errors": 0,
        }

    def _get_or_create_manager(self, manager_name: str, original_manager_page_id: str) -> str:
        """
        يجد أو ينشئ صفحة مدير في MANAGERS_DB ويقوم بالتخزين المؤقت.
        """
        # 1. البحث في الـCache
        if manager_name in self.manager_cache:
            return self.manager_cache[manager_name]

        # 2. البحث في MANAGERS_DB
        try:
            results = self.notion.databases.query(
                database_id=self.managers_db_id,
                filter={
                    "property": "اسم مدير المشروع",
                    "title": {"equals": manager_name},
                }
            ).get('results')
            
            if results:
                manager_page_id = results[0]['id']
                self.manager_cache[manager_name] = manager_page_id
                print(f"✅ تم إيجاد مدير: {manager_name}")
                return manager_page_id

        except Exception as e:
            print(f"❌ خطأ في البحث عن مدير: {manager_name}. الخطأ: {e}")
            
        # 3. عدم الإيجاد → إنشاء صفحة جديدة ونسخ المحتوى
        print(f"⭐ لا يوجد مدير باسم: {manager_name}. جاري الإنشاء والنسخ...")
        try:
            # أ. إنشاء الصفحة
            new_page = self.notion.pages.create(
                parent={"database_id": self.managers_db_id},
                properties={
                    "اسم مدير المشروع": {
                        "title": [{"text": {"content": manager_name}}]
                    }
                }
            )
            manager_page_id = new_page['id']
            self.manager_cache[manager_name] = manager_page_id
            self.stats["new_manager_pages"] += 1

            # ب. نسخ محتوى التيمبليت
            self._copy_template_content(manager_page_id)
            
            return manager_page_id

        except Exception as e:
            print(f"❌ خطأ في إنشاء صفحة مدير أو نسخ التيمبليت: {manager_name}. الخطأ: {e}")
            return None


    def _copy_template_content(self, target_page_id):
        """
        ينسخ محتوى التيمبليت (بما في ذلك إنشاء child_database جديد) إلى الصفحة الهدف.
        """
        try:
            # 1. جلب بلوكات التيمبليت
            template_blocks = self.notion.blocks.children.list(
                block_id=self.template_page_id
            ).get('results')

            # 2. تحويل البلوكات للنسخ (خاصة child_database)
            new_children_blocks = transform_template_blocks(template_blocks, self.notion)

            # 3. إلحاق البلوكات بالصفحة الهدف
            if new_children_blocks:
                self.notion.blocks.children.append(
                    block_id=target_page_id,
                    children=new_children_blocks
                )
                print(f"✅ تم نسخ {len(new_children_blocks)} بلوك من التيمبليت.")
        except Exception as e:
            print(f"❌ خطأ حرج في نسخ محتوى التيمبليت إلى {target_page_id}. الخطأ: {e}")


    def _find_or_create_projects_db(self, manager_page_id: str) -> str or None:
        """
        يتأكد من وجود child_database بعنوان "مشاريعك" داخل صفحة المدير.
        إذا لم يوجد، يقوم بنسخ التيمبليت ثم يبحث مجدداً.
        """
        # 1. البحث الأولي عن child_database "مشاريعك"
        try:
            manager_blocks = self.notion.blocks.children.list(
                block_id=manager_page_id
            ).get('results')
            
            db_id = find_child_database_id(manager_blocks, "مشاريعك")
            if db_id:
                return db_id
        except Exception as e:
            print(f"❌ خطأ في جلب بلوكات صفحة المدير {manager_page_id}: {e}")
            return None

        # 2. إذا لم يتم العثور → نسخ التيمبليت ثم البحث مرة أخرى
        print(f"⚠️ لم يتم العثور على 'مشاريعك' في صفحة المدير {manager_page_id}. جاري محاولة النسخ والبحث مجدداً...")
        self._copy_template_content(manager_page_id) # قد يكون تم نسخه بالفعل في _get_or_create_manager
        
        try:
            # البحث مرة أخرى بعد عملية النسخ
            manager_blocks_after_copy = self.notion.blocks.children.list(
                block_id=manager_page_id
            ).get('results')
            
            db_id_after_copy = find_child_database_id(manager_blocks_after_copy, "مشاريعك")
            if db_id_after_copy:
                print("✅ تم العثور على 'مشاريعك' بعد النسخ بنجاح.")
                return db_id_after_copy
            else:
                print(f"❌ فشل حرج: لم يتم العثور على child_database 'مشاريعك' حتى بعد محاولة النسخ لـ: {manager_page_id}")
                self.stats["errors"] += 1
                return None
        except Exception as e:
            print(f"❌ خطأ في البحث الثاني عن 'مشاريعك': {e}")
            self.stats["errors"] += 1
            return None


    def _upsert_project_in_manager_db(self, manager_db_id: str, project_data: dict):
        """
        يحدث صفحة المشروع إذا وجدت، أو ينشئها داخل داتابيس المدير.
        """
        project_name = project_data['name']
        
        # 1. البحث عن المشروع بنفس الاسم
        try:
            results = self.notion.databases.query(
                database_id=manager_db_id,
                filter={
                    "property": "اسم المشروع",
                    "title": {"equals": project_name},
                }
            ).get('results')
            
            # 2. إعداد الخصائص للتحديث/الإنشاء
            update_properties = {
                "اسم المشروع": {
                    "title": [{"text": {"content": project_name}}]
                },
                "حالة المشروع": {
                    "select": {"name": project_data['status']}
                },
                "المبلغ المتبقي": {
                    "number": project_data['remaining_amount']
                },
            }

            if results:
                # تحديث
                project_page_id = results[0]['id']
                self.notion.pages.update(
                    page_id=project_page_id,
                    properties=update_properties
                )
                self.stats["updated_projects"] += 1
                print(f"   ⬆️ تم تحديث المشروع: {project_name}")
            else:
                # إنشاء
                self.notion.pages.create(
                    parent={"database_id": manager_db_id},
                    properties=update_properties
                )
                self.stats["added_projects"] += 1
                print(f"   ➕ تم إضافة المشروع الجديد: {project_name}")

        except Exception as e:
            print(f"   ❌ خطأ في عملية Upsert للمشروع {project_name} في داتابيس المدير: {e}")
            self.stats["errors"] += 1


    def process_project(self, project_page):
        """
        المنطق الرئيسي لمعالجة مشروع واحد.
        """
        project_name = get_property_value(project_page, "اسم المشروع", 'title')
        project_status = get_property_value(project_page, "حالة المشروع", 'select')
        project_amount = get_property_value(project_page, "المبلغ المتبقي", 'formula.number')
        manager_relation_ids = get_property_value(project_page, "مدير المشروع", 'relation')
        
        self.stats["processed_projects"] += 1
        print(f"\n--- جاري معالجة المشروع: {project_name} ---")

        if not all([project_name, project_status, project_amount, manager_relation_ids]):
            print("⚠️ تجاهل المشروع: بيانات أساسية مفقودة (الاسم/الحالة/المبلغ/المدير).")
            self.stats["errors"] += 1
            return

        project_data = {
            "name": project_name,
            "status": project_status,
            "remaining_amount": project_amount,
        }

        # جلب معلومات المديرين لكل علاقة
        for manager_page_id_rel in manager_relation_ids:
            try:
                # 1. جلب صفحة المدير الأصلية لاستخراج الاسم
                manager_page_rel = self.notion.pages.retrieve(page_id=manager_page_id_rel)
                manager_name = get_property_value(manager_page_rel, "Name", 'title')
                
                if not manager_name:
                    print(f"⚠️ فشل في استخراج اسم المدير من صفحة العلاقة {manager_page_id_rel}. تجاهل هذا المدير.")
                    continue

                # 2. الحصول على أو إنشاء صفحة المدير في MANAGERS_DB
                manager_page_in_db_id = self._get_or_create_manager(manager_name, manager_page_id_rel)
                
                if not manager_page_in_db_id:
                    print(f"❌ فشل حرج في الحصول على صفحة المدير {manager_name} في MANAGERS_DB. تخطي.")
                    self.stats["errors"] += 1
                    continue

                # 3. إيجاد child_database "مشاريعك" داخل صفحة المدير
                manager_projects_db_id = self._find_or_create_projects_db(manager_page_in_db_id)

                if manager_projects_db_id:
                    # 4. تحديث/إنشاء المشروع داخل داتابيس المدير
                    self._upsert_project_in_manager_db(manager_projects_db_id, project_data)
                else:
                    print(f"❌ تخطي عملية Upsert: فشل في إيجاد 'مشاريعك' لـ {manager_name}.")
                    self.stats["errors"] += 1

            except Exception as e:
                print(f"❌ خطأ غير متوقع أثناء معالجة مدير المشروع {manager_page_id_rel}. الخطأ: {e}")
                self.stats["errors"] += 1


    def run(self):
        """
        تشغيل السكربت.
        """
        print("🚀 بدء تشغيل سكريبت مزامنة مشاريع Notion...")
        
        # 1. جلب جميع المشاريع من PROJECTS_DB
        try:
            results = self.notion.databases.query(
                database_id=self.projects_db_id
            ).get('results')
            
            print(f"🔍 تم جلب {len(results)} مشروع من قاعدة البيانات.")
            
            # 2. معالجة كل مشروع (مع try/catch لضمان الاستمرارية)
            for project_page in results:
                try:
                    self.process_project(project_page)
                except Exception as e:
                    print(f"❌ فشل معالجة مشروع بالكامل (Try/Catch). الخطأ: {e}")
                    self.stats["errors"] += 1
            
            print("\n--- ✅ انتهت معالجة جميع المشاريع ---")
            print("## 📊 الإحصائيات النهائية:")
            for key, value in self.stats.items():
                print(f"* {key.replace('_', ' ').title()}: **{value}**")

        except Exception as e:
            print(f"\n❌ خطأ حرج في جلب قاعدة بيانات المشاريع: {e}")
            print("🚨 السكربت توقف مبكراً.")

if __name__ == "__main__":
    # تأكد من أن validate_env() تم استدعائها بنجاح في config.py
    if all([NOTION_TOKEN, PROJECTS_DB_ID, MANAGERS_DB_ID, TEMPLATE_PAGE_ID]):
        processor = ProjectProcessor(
            notion_token=NOTION_TOKEN,
            projects_db_id=PROJECTS_DB_ID,
            managers_db_id=MANAGERS_DB_ID,
            template_page_id=TEMPLATE_PAGE_ID,
        )
        processor.run()
    else:
        print("\nيرجى تصحيح الأخطاء في الإعدادات والمتغيرات البيئية قبل التشغيل.")
