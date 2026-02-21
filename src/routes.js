import express from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Безопасное получение переменных (даже если они пока не заданы, сервер не упадет при запуске)
const AMO_DOMAIN = process.env.AMO_DOMAIN || 'undefined_domain';
const AMO_TOKEN = process.env.AMO_TOKEN || '';

// Используем /tmp директорию для временных файлов на Render (меньше проблем с правами)
// ВНИМАНИЕ: Файл будет очищаться при перезагрузке/сне сервера на бесплатном тарифе Render!
const PLANS_FILE = process.env.RENDER ? '/tmp/plans.json' : './plans.json';

const SUCCESS_STATUS_ID = 142; // Успешно
const LOST_STATUS_ID = 143;    // Отказ

// 🔥 ТВОИ ЦЕЛИ (ID ЭТАПА "100% ОПЛАТА")
const PIPELINE_GOALS = {
    10348918: 81840638, // Toshkent Forum
    10348938: 81840714, // Toshkent Kurs
    10490310: 82817566, // New 1
    10490314: 82817690  // New 2
};

const DEBT_STATUSES = [81840710, 81840634];
const REMAINDER_FIELD_ID = 1369949;         // Остаток долга
const PAYMENT_DEADLINE_FIELD_ID = 1376897;  // Дата окончания оплаты
const AVANS_FIELD_ID = 1369947;             // Поле АВАНС
const CONTACT_REGION_FIELD_ID = 1369961;
const TARIF_FIELD_ID = 1369945;
const BUSINESS_TYPE_FIELD_ID = 1375065;
const EMPLOYEES_COUNT_FIELD_ID = 1369957;

// 🔥 НОВЫЕ ПОЛЯ ДЛЯ ВОЗВРАТА
const REASON_RETURN_FIELD_ID = 1369951;     // Поле: Причина отказа
const REASON_RETURN_ENUM_ID = 2796541;      // Значение: Pulini qaytib oldi

const amo = axios.create({
    baseURL: `https://${AMO_DOMAIN}.amocrm.ru/api/v4`,
    headers: {
        Authorization: `Bearer ${AMO_TOKEN}`,
        'Content-Type': 'application/json',
    },
    timeout: 60000,
});

/* ===============================
  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
=============================== */
const delay = (ms) => new Promise(r => setTimeout(r, ms));
let lastRequestTime = 0;

async function amoSafeGet(url, config = {}) {
    const now = Date.now();
    const diff = now - lastRequestTime;
    if (diff < 200) await delay(200 - diff);
    lastRequestTime = Date.now();
    return amo.get(url, config);
}

function getManagerFilter(managerIdParam) {
    if (!managerIdParam) return {};
    const ids = String(managerIdParam).split(',').map(Number);
    return { responsible_user_id: ids };
}

function buildDateFilter({ from, to, statusType }) {
    if (!from) return {};
    let field = statusType === 'closed' ? 'closed_at' : 'created_at';
    const f = String(from).length > 10 ? Math.floor(Number(from) / 1000) : Number(from);
    const t = to ? (String(to).length > 10 ? Math.floor(Number(to) / 1000) : Number(to)) : Math.floor(Date.now() / 1000);
    return { [field]: { from: f, to: t } };
}

/* ===============================
  РОУТЫ
=============================== */

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === "InsanToshkent" && password === "Insan2026") {
        res.json({ success: true, message: "Welcome", user: { name: "Administrator" } });
    } else {
        res.status(401).json({ success: false });
    }
});

// 🔥 KPI LEADS
router.get('/kpi/leads', async (req, res) => {
    try {
        const { from, to, pipeline_id, manager_id, mode } = req.query;

        if (!pipeline_id) return res.json({
            total: 0, sales: 0, salesAmount: 0, lost: 0,
            debtCount: 0, debtAmount: 0,
            overdueCount: 0, overdueAmount: 0,
            totalIncome: 0,
            refundCount: 0, refundAmount: 0
        });

        const selectedPipelineIds = String(pipeline_id).split(',').map(Number);

        // --- ЛОГИКА ДАТ ДЛЯ ОТКАЗОВ ---
        const nowServer = new Date();
        const startOfToday = Math.floor(new Date(nowServer.getFullYear(), nowServer.getMonth(), nowServer.getDate()).getTime() / 1000);
        const endOfToday = Math.floor(new Date(nowServer.getFullYear(), nowServer.getMonth(), nowServer.getDate(), 23, 59, 59).getTime() / 1000);

        const queryFrom = from ? Math.floor(Number(from)) : startOfToday;
        const queryTo = to ? Math.floor(Number(to)) : endOfToday;
        const nowTs = Math.floor(Date.now() / 1000);

        let total = 0, sales = 0, salesAmount = 0, lost = 0;
        let debtCount = 0, debtAmount = 0, overdueCount = 0, overdueAmount = 0;
        let activeAvansAmount = 0, refundCount = 0, refundAmount = 0;

        const isLaunchMode = mode === 'launch' || mode === 'mixed';

        const fetchLeads = async (customFilter) => {
            let page = 1;
            let allLeads = [];
            while (true) {
                try {
                    const { data } = await amoSafeGet('/leads', {
                        params: {
                            limit: 250, page,
                            filter: {
                                pipeline_id: selectedPipelineIds,
                                ...getManagerFilter(manager_id),
                                ...customFilter
                            }
                        }
                    });
                    const fetched = data?._embedded?.leads || [];
                    if (!fetched.length) break;
                    allLeads = [...allLeads, ...fetched];
                    if (fetched.length < 250) break;
                    page++;
                } catch (e) { break; }
            }
            return allLeads;
        };

        let leads = [];
        if (isLaunchMode) {
            const activeLeads = await fetchLeads({});
            const closedLeads = await fetchLeads({
                status: [SUCCESS_STATUS_ID, LOST_STATUS_ID],
                closed_at: { from: queryFrom, to: queryTo }
            });
            leads = [...activeLeads, ...closedLeads];
        } else {
            leads = await fetchLeads(buildDateFilter({ from, to, statusType: 'created' }));
        }

        const uniqueLeads = Array.from(new Map(leads.map(item => [item.id, item])).values());

        uniqueLeads.forEach(l => {
            const leadPipelineId = Number(l.pipeline_id);
            const statusId = Number(l.status_id);
            const closedAt = Number(l.closed_at);
            const price = Number(l.price || 0);

            if (!selectedPipelineIds.includes(leadPipelineId)) return;

            // --- 1. ОТКАЗ (143) ---
            if (statusId === LOST_STATUS_ID) {
                if (closedAt >= queryFrom && closedAt <= queryTo) {
                    total++;
                    lost++;

                    const reasonField = l.custom_fields_values?.find(f => Number(f.field_id) === REASON_RETURN_FIELD_ID);
                    if (reasonField?.values?.[0]?.enum_id === REASON_RETURN_ENUM_ID) {
                        refundCount++;
                        const avansField = l.custom_fields_values?.find(f => Number(f.field_id) === AVANS_FIELD_ID);
                        if (avansField?.values?.[0]) {
                            const val = parseFloat(String(avansField.values[0].value).replace(/[^0-9.]/g, '') || 0);
                            refundAmount += val;
                        }
                    }
                }
                return; 
            }

            // --- 2. УСПЕШНО (142) ---
            if (statusId === SUCCESS_STATUS_ID) {
                if (closedAt >= queryFrom && closedAt <= queryTo) {
                    total++;
                    if (!isLaunchMode) {
                        sales++;
                        salesAmount += price;
                    }
                }
                return;
            }

            // --- 3. АКТИВНЫЕ СДЕЛКИ ---
            total++;

            const goalId = PIPELINE_GOALS[leadPipelineId];
            const isSale = (isLaunchMode && statusId === goalId);

            if (isSale) {
                sales++;
                salesAmount += price;
            } else {
                const avansField = l.custom_fields_values?.find(f => Number(f.field_id) === AVANS_FIELD_ID);
                if (avansField?.values?.[0]) {
                    const val = parseFloat(String(avansField.values[0].value).replace(/[^0-9.]/g, '') || 0);
                    if (val > 0) activeAvansAmount += val;
                }
            }

            // --- 4. ДОЛГИ И ПРОСРОЧКА ---
            if (DEBT_STATUSES.includes(statusId)) {
                const debtField = l.custom_fields_values?.find(f => Number(f.field_id) === REMAINDER_FIELD_ID);
                let debtVal = 0;
                if (debtField?.values?.[0]) {
                    debtVal = parseFloat(String(debtField.values[0].value).replace(/[^0-9.]/g, '') || 0);
                }

                if (debtVal > 0) {
                    debtCount++;
                    debtAmount += debtVal;

                    const deadlineField = l.custom_fields_values?.find(f => Number(f.field_id) === PAYMENT_DEADLINE_FIELD_ID);
                    if (deadlineField?.values?.[0]) {
                        const deadlineTs = Number(deadlineField.values[0].value);
                        if (deadlineTs < nowTs) {
                            overdueCount++;
                            overdueAmount += debtVal;
                        }
                    }
                }
            }
        });

        const totalIncome = salesAmount + activeAvansAmount;

        res.json({ 
            total, sales, salesAmount, lost, debtCount, debtAmount, overdueCount, overdueAmount,
            totalIncome, refundCount, refundAmount,
            conversion: total ? ((sales / total) * 100).toFixed(1) : 0, 
            avgCheck: sales ? Math.round(salesAmount / sales) : 0
        });

    } catch (e) { 
        res.status(500).json({ total: 0 }); 
    }
});

// ЕДИНЫЙ РОУТ ДЛЯ МАРКЕТИНГА
router.get('/marketing/analytics', async (req, res) => {
    try {
        const { from, to, pipeline_id, manager_id, status_type = 'all', global_mode } = req.query;
        if (!pipeline_id) return res.json({ sources: [], tarifs: [], regions: [], business: [], employees: [] });

        const selectedPipelineIds = String(pipeline_id).split(',').map(Number);
        const nowServer = new Date();
        const startOfToday = Math.floor(new Date(nowServer.getFullYear(), nowServer.getMonth(), nowServer.getDate()).getTime() / 1000);
        const endOfToday = Math.floor(new Date(nowServer.getFullYear(), nowServer.getMonth(), nowServer.getDate(), 23, 59, 59).getTime() / 1000);

        const queryFrom = from ? Math.floor(Number(from)) : startOfToday;
        const queryTo = to ? Math.floor(Number(to)) : endOfToday;
        
        const isLaunchMode = global_mode === 'mixed' || global_mode === 'launch';

        const fetchAllPages = async (customFilter) => {
            let page = 1;
            let all = [];
            while (true) {
                try {
                    const params = {
                        limit: 250, page,
                        filter: {
                            pipeline_id: selectedPipelineIds,
                            ...getManagerFilter(manager_id),
                            ...customFilter
                        },
                        with: 'contacts,source'
                    };
                    const { data } = await amoSafeGet('/leads', { params });
                    const fetched = data?._embedded?.leads || [];
                    if (!fetched.length) break;
                    all = [...all, ...fetched];
                    if (fetched.length < 250) break;
                    page++;
                } catch (e) { break; }
            }
            return all;
        };

        let rawLeads = [];
        if (isLaunchMode) {
            const activeLeads = await fetchAllPages({});
            const closedLeads = await fetchAllPages({
                status: [SUCCESS_STATUS_ID, LOST_STATUS_ID],
                closed_at: { from: queryFrom, to: queryTo }
            });
            rawLeads = [...activeLeads, ...closedLeads];
        } else {
            rawLeads = await fetchAllPages({ created_at: { from: queryFrom, to: queryTo } });
        }

        const uniqueMap = new Map(rawLeads.map(l => [l.id, l]));
        const uniqueLeads = Array.from(uniqueMap.values());

        const filteredLeads = uniqueLeads.filter(lead => {
            const pId = Number(lead.pipeline_id);
            const sId = Number(lead.status_id);
            const closedAt = Number(lead.closed_at);

            if (!selectedPipelineIds.includes(pId)) return false;

            const isClosedInPeriod = closedAt >= queryFrom && closedAt <= queryTo;

            if (status_type === 'success') return sId === SUCCESS_STATUS_ID && isClosedInPeriod;
            if (status_type === 'lost') return sId === LOST_STATUS_ID && isClosedInPeriod;
            if (status_type === 'realtime') {
                const goalId = PIPELINE_GOALS[pId];
                return isLaunchMode ? (sId === goalId) : (sId === SUCCESS_STATUS_ID && isClosedInPeriod);
            }

            if (isLaunchMode) {
                if (sId === SUCCESS_STATUS_ID || sId === LOST_STATUS_ID) {
                    return isClosedInPeriod;
                }
                return true; 
            }
            return true; 
        });

        const sources = {}; const tarifs = {}; const regions = {}; const business = {}; const employees = {};
        const contactMap = {};

        filteredLeads.forEach(l => {
            const src = l._embedded?.source?.name || 'Noma’lum (Kiritilmagan)';
            sources[src] = (sources[src] || 0) + 1;

            const trf = l.custom_fields_values?.find(f => Number(f.field_id) === TARIF_FIELD_ID)?.values?.[0]?.value || 'Noma’lum (Kiritilmagan)';
            tarifs[trf] = (tarifs[trf] || 0) + 1;

            const cId = l._embedded?.contacts?.[0]?.id;
            if (cId) contactMap[cId] = (contactMap[cId] || 0) + 1;
            else {
                regions['Noma’lum (Kiritilmagan)'] = (regions['Noma’lum (Kiritilmagan)'] || 0) + 1;
                business['Noma’lum (Kiritilmagan)'] = (business['Noma’lum (Kiritilmagan)'] || 0) + 1;
                employees['Noma’lum (Kiritilmagan)'] = (employees['Noma’lum (Kiritilmagan)'] || 0) + 1;
            }
        });

        const ids = Object.keys(contactMap);
        if (ids.length > 0) {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const { data } = await amoSafeGet('/contacts', { params: { filter: { id: chunk } } });
                data?._embedded?.contacts?.forEach(c => {
                    const count = contactMap[c.id] || 0;
                    
                    const reg = c.custom_fields_values?.find(f => Number(f.field_id) === CONTACT_REGION_FIELD_ID)?.values?.[0]?.value || 'Noma’lum (Kiritilmagan)';
                    regions[reg] = (regions[reg] || 0) + count;

                    const bus = c.custom_fields_values?.find(f => Number(f.field_id) === BUSINESS_TYPE_FIELD_ID)?.values?.[0]?.value || 'Noma’lum (Kiritilmagan)';
                    business[bus] = (business[bus] || 0) + count;

                    const emp = c.custom_fields_values?.find(f => Number(f.field_id) === EMPLOYEES_COUNT_FIELD_ID)?.values?.[0]?.value || 'Noma’lum (Kiritilmagan)';
                    employees[emp] = (employees[emp] || 0) + count;
                });
                await delay(100);
            }
        }

        const formatData = (map) => Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

        res.json({
            sources: formatData(sources),
            tarifs: formatData(tarifs),
            regions: formatData(regions),
            business: formatData(business),
            employees: formatData(employees).sort((a,b) => {
                if (a.name.includes('Noma’lum')) return 1;
                if (b.name.includes('Noma’lum')) return -1;
                return parseInt(String(b.name).match(/\d+/) || '0') - parseInt(String(a.name).match(/\d+/) || '0');
            })
        });

    } catch (e) {
        res.status(500).json({ sources: [], tarifs: [], regions: [], business: [], employees: [] });
    }
});

// 7. ВОРОНКА
router.get('/dashboard/funnel', async (req, res) => {
    try {
        const { pipeline_id, manager_id } = req.query;
        if (!pipeline_id) return res.json([]);

        const firstPipelineId = String(pipeline_id).split(',')[0];
        const { data: pipeline } = await amoSafeGet(`/leads/pipelines/${firstPipelineId}`);
        const stageMap = {};
        (pipeline?._embedded?.statuses || []).forEach(s => {
            stageMap[s.id] = { id: s.id, name: s.name, value: 0, sort: s.sort };
        });

        let page = 1;
        while (true) {
            const { data } = await amoSafeGet('/leads', { 
                params: { 
                    limit: 250, page, 
                    filter: { 
                        pipeline_id: String(pipeline_id).split(',').map(Number), 
                        ...getManagerFilter(manager_id)
                    } 
                } 
            });
            const leads = data?._embedded?.leads || [];
            if (!leads.length) break;
            leads.forEach(l => { if (stageMap[l.status_id]) stageMap[l.status_id].value++; });
            if (leads.length < 250) break;
            page++;
        }
        res.json(Object.values(stageMap).sort((a, b) => a.sort - b.sort));
    } catch (e) { res.status(500).json([]); }
});

// 8. СПРАВОЧНИКИ
router.get('/pipelines', async (req, res) => {
    try {
        const { data } = await amoSafeGet('/leads/pipelines');
        const pipelines = data?._embedded?.pipelines?.map(p => ({ id: p.id, name: p.name })) || [];
        res.json(pipelines);
    } catch (e) { res.json([]); }
});

router.get('/managers', async (req, res) => {
    try {
        const { data } = await amoSafeGet('/users');
        const managers = data?._embedded?.users?.map(u => ({ id: u.id, name: u.name })) || [];
        res.json(managers);
    } catch (e) { res.json([]); }
});

// =========================================================
// 9. СОХРАНЕНИЕ ПЛАНОВ И СТАТУС (С ЗАЩИТОЙ ДЛЯ RENDER)
// =========================================================

const readPlans = () => {
    if (!fs.existsSync(PLANS_FILE)) return [];
    try {
        const raw = fs.readFileSync(PLANS_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        return [];
    }
};

router.post('/plan/save', (req, res) => {
    try {
        const { 
            manager_id, pipeline_id, start_date, end_date, 
            target_deals, target_amount, type, minimalka,
            target_standart, target_standart_plus, target_premium, target_vip,
            target_people
        } = req.body;

        let plans = readPlans();
        plans = plans.filter(p => !(String(p.manager_id) === String(manager_id) && p.start_date === start_date));

        plans.push({ 
            manager_id: String(manager_id), 
            pipeline_id: Number(pipeline_id), 
            start_date, 
            end_date, 
            type: type || (manager_id === '0' ? 'general' : 'manager'),
            target_deals: Number(target_deals || 0), 
            target_amount: Number(target_amount || 0),
            minimalka: Number(minimalka || 15),
            target_standart: Number(target_standart || 0),
            target_standart_plus: Number(target_standart_plus || 0),
            target_premium: Number(target_premium || 0),
            target_vip: Number(target_vip || 0),
            target_people: Number(target_people || 0)
        });

        // Защита от ошибок записи на облачных хостингах
        fs.writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2));
        res.json({ success: true });
    } catch (error) { 
        console.error("Plan save error (Возможно, нет прав на запись):", error);
        res.status(500).json({ success: false, error: "Не удалось сохранить план" }); 
    }
});

router.get('/plan/status', async (req, res) => {
    try {
        const { pipeline_id, manager_id, from, to, mode } = req.query;
        const allPlans = readPlans();
        
        const selectedPipelines = pipeline_id ? pipeline_id.split(',').map(Number) : [];
        const isLaunchMode = mode === 'launch' || mode === 'mixed';

        const results = [];

        for (const plan of allPlans) {
            if (selectedPipelines.length > 0 && !selectedPipelines.includes(Number(plan.pipeline_id))) {
                continue;
            }

            const goalStatusId = PIPELINE_GOALS[plan.pipeline_id];
            if (!goalStatusId) continue;

            let page = 1;
            let allLeads = [];
            while (true) {
                const filter = { 
                    pipeline_id: [Number(plan.pipeline_id)]
                };

                if (plan.manager_id !== '0') {
                    filter.responsible_user_id = [Number(plan.manager_id)];
                }

                const { data } = await amoSafeGet('/leads', { params: { filter, limit: 250, page } });
                const fetched = data?._embedded?.leads || [];
                if (!fetched.length) break;
                
                allLeads = [...allLeads, ...fetched];
                if (fetched.length < 250) break;
                page++;
            }

            let actual_deals = 0;
            let actual_amount = 0; 
            let actual_people = 0;
            let total_remainder = 0; 
            
            const tarif_stats = {
                standart: { full: 0 },
                standart_plus: { full: 0 }, 
                premium: { full: 0 },
                vip: { full: 0 }
            };

            const dateFrom = from ? Number(from) * 1000 : new Date(plan.start_date).getTime();
            const dateTo = to ? Number(to) * 1000 : new Date(plan.end_date).setHours(23, 59, 59);

            allLeads.forEach(l => {
                const statusId = Number(l.status_id);
                
                if (DEBT_STATUSES.includes(statusId)) {
                    const debtField = l.custom_fields_values?.find(f => Number(f.field_id) === REMAINDER_FIELD_ID);
                    if (debtField?.values?.[0]) {
                        const debtVal = parseFloat(String(debtField.values[0].value).replace(/[^0-9.]/g, '') || 0);
                        total_remainder += debtVal;
                    }
                }

                const leadTime = l.updated_at * 1000;
                const isSale = (statusId === goalStatusId);

                if (isSale && leadTime >= dateFrom && leadTime <= dateTo) {
                    actual_deals++;
                    actual_amount += Number(l.price || 0);

                    const tarifFieldValue = l.custom_fields_values?.find(f => Number(f.field_id) === TARIF_FIELD_ID)?.values[0].value?.toLowerCase() || '';
                    let key = '';
                    let pCount = 1;

                    if (tarifFieldValue.includes('plus') || tarifFieldValue.includes('+')) {
                        key = 'standart_plus'; pCount = 2;
                    } else if (tarifFieldValue.includes('standart')) {
                        key = 'standart';
                    } else if (tarifFieldValue.includes('premium')) {
                        key = 'premium';
                    } else if (tarifFieldValue.includes('vip')) {
                        key = 'vip';
                    }

                    if (key) {
                        tarif_stats[key].full++;
                    }
                    actual_people += pCount;
                }
            });

            results.push({
                ...plan,
                actual_deals,
                actual_amount,
                actual_people,
                total_remainder, 
                tarif_stats,
                progress_deals: plan.target_deals ? ((actual_deals / plan.target_deals) * 100).toFixed(1) : "0.0"
            });
        }

        res.json(results);
    } catch (e) {
        console.error("Ошибка в плане:", e);
        res.status(500).json([]);
    }
});

router.delete('/plan/delete', (req, res) => {
    try {
        const { manager_id, start_date } = req.query;
        let plans = readPlans();
        plans = plans.filter(p => !(String(p.manager_id) === String(manager_id) && p.start_date === start_date));
        fs.writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: "Не удалось удалить план" });
    }
});

export default router;

