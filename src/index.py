import os
import sys
from notion_client import Client
from dotenv import load_dotenv

# --- 1. الإعدادات والتحقق من المتغيرات البيئية ---

load_dotenv()

NOTION_TOKEN = os.environ.get("NOTION_TOKEN")
PROJECTS_DB = os.environ.get("PROJECTS_DB")
MANAGERS_DB = os.environ.get("MANAGERS_DB")
TEMPLATE_PAGE_ID = os.environ.get("TEMPLATE_PAGE_ID")

def validate_env():
    """يتحقق من وجود جميع المتغيرات البيئية المطلوبة."""
    required = {
        "NOTION_TOKEN": NOTION_TOKEN,
        "PROJECTS_DB": PROJECTS_DB,
        "MANAGERS_DB": MANAGERS_DB,
        "TEMPLATE_PAGE_ID": TEMPLATE_PAGE_ID,
    }
    missing = [key for key, value in required.items() if not value]
    
    if missing:
        print(
            f"❌ خطأ في الإعدادات: المتغيرات البيئية التالية مفقودة: {', '.join(missing)}. "
            "الرجاء التأكد من وجودها في ملف .env."
        )
        sys.exit(1)

# --- 2. الدوال المساعدة وقراءة الخصائص (Helpers) ---

def get_property_value(page: dict, prop_name: str, prop_type: str):
    """يقرأ قيمة الخاصية بشكل آمن."""
    try:
        prop = page['properties'].get(prop_name)
        if not prop:
            return None

        if prop_type == 'title':
            return prop.get('title', [{}])[0].get('plain_text')
        
        elif prop_type == 'select':
            return prop.get('select', {}).get('name')

        elif prop_type == 'formula.number':
            formula_data = prop.get('formula')
            if formula_data and formula_data.get('type') == 'number':
                return formula_data.get('number')
            return None

        elif prop_type == 'relation':
            return [rel['id'] for rel in prop.get('relation', [])]

    except Exception as e:
        print(f"⚠️ تحذير: فشل في قراءة الخاصية '{prop_name}' من نوع '{prop_type}'. الخطأ: {e}")
        return None
    
    return None

def find_child_database_id(blocks_list: list, db_title: str) -> str or None:
    """يبحث عن أول child_database بعنوان محدد ضمن قائمة البلوكات."""
    for block in blocks_list:
        if block.get('type') == 'child_database':
            try:
                title_obj = block['child_database'].get('title')
                if title_obj and title_obj[0].get('plain_text') == db_title:
                     return block['id']
            except (KeyError, IndexError):
                continue
    return None

def create_inline_database_blocks(original_db_id: str, notion_client: Client) -> dict:
    try:
        original_db = notion_client.databases.retrieve(database_id=original_db_id)
        properties_schema = original_db.get('properties', {})

        safe_properties = {
            name: prop for name, prop in properties_schema.items() 
            if prop['type'] not in ['rollup', 'formula', 'created_time', 'last_edited_time']
        }

        db_block = {
            "type": "child_database",
            "child_database": {
                "title": [
                    {
                        "type": "text",
                        "text": {
                            "content": "مشاريعك" 
                        }
                    }
                ],
                "properties": safe_properties
            }
        }
        return db_block
    except Exception as e:
        print(f"❌ خطأ: فشل في إنشاء بلوك child_database لـ 'مشاريعك': {e}")
        return None

def transform_template_blocks(blocks_list: list, notion_client: Client):
    new_children = []
    for block in blocks_list:
        block_type = block.get('type')
        if block_type == 'child_database':
            original_db_id = block['child_database']['id']
            new_db_block = create_inline_database_blocks(original_db_id, notion_client)
            if new_db_block:
                new_children.append(new_db_block)
        elif block_type not in ['unsupported', 'synced_block', 'child_page']:
            new_block_data = {
                k: v for k, v in block.get(block_type, {}).items() 
                if k not in ['type', 'id', 'has_children', 'created_time']
            }

            new_block = {
                block_type: new_block_data, 
                "type": block_type
            }
            
            new_children.append(new_block)

    return new_children

# --- 3. منطق التنفيذ الرئيسي (ProjectProcessor) ---

class ProjectProcessor:
    def __init__(self, notion_token, projects_db_id, managers_db_id, template_page_id):
        self.notion = Client(auth=notion_token)
        self.projects_db_id = projects_db_id
        self.managers_db_id = managers_db_id
        self.template_page_id = template_page_id
        
        self.manager_cache = {}
        
        self.stats = {
            "processed_projects": 0,
            "added_projects": 0,
            "updated_projects": 0,
            "new_manager_pages": 0,
            "errors": 0,
        }

    def _copy_template_content(self, target_page_id):
        try:
            template_blocks = self.notion.blocks.children.list(
                block_id=self.template_page_id
            ).get('results')

            new_children_blocks = transform_template_blocks(template_blocks, self.notion)

            if new_children_blocks:
                self.notion.blocks.children.append(
                    block_id=target_page_id,
                    children=new_children_blocks
                )
                print(f"✅ تم نسخ {len(new_children_blocks)} بلوك من التيمبليت إلى الصفحة.")
            return True
        except Exception as e:
            print(f"❌ خطأ حرج في نسخ محتوى التيمبليت إلى {target_page_id}. الخطأ: {e}")
            return False

    def _get_or_create_manager(self, manager_name: str, original_manager_page_id: str) -> str or None:
        if manager_name in self.manager_cache:
            return self.manager_cache[manager_name]

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
                print(f"✅ تم إيجاد مدير موجود: {manager_name}")
                return manager_page_id

        except Exception as e:
            print(f"❌ خطأ في البحث عن مدير: {manager_name}. الخطأ: {e}")
            
        print(f"⭐ لا يوجد مدير باسم: {manager_name}. جاري الإنشاء والنسخ...")
        try:
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

            self._copy_template_content(manager_page_id)
            
            return manager_page_id

        except Exception as e:
            print(f"❌ خطأ في إنشاء صفحة مدير أو نسخ التيمبليت: {manager_name}. الخطأ: {e}")
            return None

    def _find_or_create_projects_db(self, manager_page_id: str) -> str or None:
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

        print(f"❌ فشل حرج: لم يتم العثور على child_database 'مشاريعك' في صفحة المدير {manager_page_id}.")
        self.stats["errors"] += 1
        return None

    def _upsert_project_in_manager_db(self, manager_db_id: str, project_data: dict):
        project_name = project_data['name']
        
        try:
            results = self.notion.databases.query(
                database_id=manager_db_id,
                filter={
                    "property": "اسم المشروع",
                    "title": {"equals": project_name},
                }
            ).get('results')
            
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
                project_page_id = results[0]['id']
                self.notion.pages.update(
                    page_id=project_page_id,
                    properties=update_properties
                )
                self.stats["updated_projects"] += 1
                print(f"   ⬆️ تم تحديث المشروع: {project_name}")
            else:
                self.notion.pages.create(
                    parent={"database_id": manager_db_id},
                    properties=update_properties
                )
                self.stats["added_projects"] += 1
                print(f"   ➕ تم إضافة المشروع الجديد: {project_name}")

        except Exception as e:
            print(f"   ❌ خطأ في عملية Upsert للمشروع {project_name} في داتابيس المدير: {e}")
            self.stats["errors"] += 1

    def process_project(self, project_page: dict):
        project_name = get_property_value(project_page, "اسم المشروع", 'title')
        project_status = get_property_value(project_page, "حالة المشروع", 'select')
        project_amount = get_property_value(project_page, "المبلغ المتبقي", 'formula.number')
        manager_relation_ids = get_property_value(project_page, "مدير المشروع", 'relation')
        
        self.stats["processed_projects"] += 1
        project_id = project_page['id']
        print(f"\n--- جاري معالجة المشروع: {project_name or project_id} ---")

        if not all([project_name, project_status, project_amount, manager_relation_ids]):
            print("⚠️ تجاهل المشروع: بيانات أساسية مفقودة (الاسم/الحالة/المبلغ/المدير).")
            self.stats["errors"] += 1
            return

        project_data = {
            "name": project_name,
            "status": project_status,
            "remaining_amount": project_amount,
        }

        for manager_page_id_rel in manager_relation_ids:
            try:
                manager_page_rel = self.notion.pages.retrieve(page_id=manager_page_id_rel)

                manager_name = get_property_value(manager_page_rel, "Name", 'title') 
                if not manager_name:
                     manager_name = get_property_value(manager_page_rel, "Title", 'title')

                if not manager_name:
                    print(f"⚠️ فشل في استخراج اسم المدير من صفحة العلاقة {manager_page_id_rel}. تجاهل.")
                    continue

                manager_page_in_db_id = self._get_or_create_manager(manager_name, manager_page_id_rel)
                
                if not manager_page_in_db_id:
                    self.stats["errors"] += 1
                    continue

                manager_projects_db_id = self._find_or_create_projects_db(manager_page_in_db_id)

                if manager_projects_db_id:
                    self._upsert_project_in_manager_db(manager_projects_db_id, project_data)
                else:
                    print(f"❌ تخطي عملية Upsert: فشل في إيجاد 'مشاريعك' لـ {manager_name}.")
                    self.stats["errors"] += 1

            except Exception as e:
                print(f"❌ خطأ غير متوقع أثناء معالجة مدير المشروع {manager_page_id_rel}. الخطأ: {e}")
                self.stats["errors"] += 1

    def run(self):
        print("🚀 بدء تشغيل سكريبت مزامنة مشاريع Notion...")
        
        try:
            results = self.notion.databases.query(
                database_id=self.projects_db_id
            ).get('results')
            
            print(f"🔍 تم جلب {len(results)} مشروع من قاعدة البيانات.")
            
            for project_page in results:
                try:
                    self.process_project(project_page)
                except Exception as e:
                    print(f"❌ فشل معالجة مشروع بالكامل (Try/Catch الخارجي). الخطأ: {e}")
                    self.stats["errors"] += 1
            
            print("\n" + "="*50)
            print("--- ✅ انتهت معالجة جميع المشاريع ---")
            print("## 📊 الإحصائيات النهائية:")
            for key, value in self.stats.items():
                print(f"* {key.replace('_', ' ').title()}: **{value}**")
            print("="*50)

        except Exception as e:
            print(f"\n❌ خطأ حرج في جلب قاعدة بيانات المشاريع: {e}")
            print("🚨 السكربت توقف مبكراً.")

# ----------------------------------------------------
# 🔥🔥🔥 التعديل الوحيد اللي يخليك ترتاح — هنا فقط 🔥🔥🔥
# ----------------------------------------------------

if __name__ == "__main__":
    validate_env()
    
    processor = ProjectProcessor(
        notion_token=NOTION_TOKEN,
        projects_db_id=PROJECTS_DB,     # ← هنا كان الخطأ — الآن صحيح
        managers_db_id=MANAGERS_DB,     # ← الآن يقرأ Secret الصحيح
        template_page_id=TEMPLATE_PAGE_ID,
    )

    processor.run()
