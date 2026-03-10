const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());
app.use(cors());

const BOLNA_API_KEY = process.env.BOLNA_API_KEY;
const BOLNA_API_URL = 'https://api.bolna.dev/call';

const MONGODB_URI = process.env.MONGODB_URI;
let db = null;

async function connectDB() {
    if (db) return db;
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        console.log('Connected to MongoDB');
        return db;
    } catch (error) {
        console.error('MongoDB connection error:', error);
        throw error;
    }
}

// ── Lead Master endpoints ─────────────────────────────────────────────────────

const SORT_BY_STATUS = {
    potential: { Date: -1 },
    new: { Date: -1 },
    'srf/mql': { SRF_MQL_Date: -1 },
    sql: { SQL_Date: -1 },
    followup: { Follow_Up_Date: -1 },
    'follow up': { Follow_Up_Date: -1 },
    lost: { Date: -1 },
    po: { Date: -1 },
};

// Statuses with multiple spellings.  Keys are lowercase.
const STATUS_REGEX_MAP = {
    followup: 'follow[\\s_-]?up',
    'follow up': 'follow[\\s_-]?up',
};

function buildStatusRegex(statusValue) {
    const key = statusValue.toLowerCase();
    const pattern = STATUS_REGEX_MAP[key] || statusValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { $regex: `^${pattern}$`, $options: 'i' };
}

// GET /api/leads?status=Potential|SRF/MQL|SQL|Followup|Lost&agent=<Lead_Owner>&search=<text>
app.get('/api/leads', async (req, res) => {
    try {
        const database = await connectDB();
        const collection = database.collection('leads_master');

        const { status, agent, search } = req.query;

        if (!status) {
            return res.status(400).json({ success: false, error: 'status query param is required.' });
        }

        // Query the 'Status' field (capital S) — the primary CRM field
        const query = { Status: buildStatusRegex(status) };

        if (agent && agent !== 'All Agents') {
            query['Lead_Owner'] = { $regex: `^${agent}$`, $options: 'i' };
        }

        if (search && search.trim()) {
            const regex = { $regex: search.trim(), $options: 'i' };
            query['$or'] = [
                { 'Client_Company_Name': regex },
                { 'Client_Person_Name': regex },
                { 'Client_Number': regex },
                { 'Enquiry Code': regex },
                { 'Lead_Owner': regex },
            ];
        }

        const sortOrder = SORT_BY_STATUS[status.toLowerCase()] || { _id: -1 };

        const leads = await collection
            .find(query)
            .sort(sortOrder)
            .toArray();

        res.json({ success: true, data: leads, count: leads.length });
    } catch (error) {
        console.error('Error fetching leads:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch leads.' });
    }
});

// GET /api/leads/agents – distinct Lead_Owner values, optionally scoped to a Status
app.get('/api/leads/agents', async (req, res) => {
    try {
        const database = await connectDB();
        const collection = database.collection('leads_master');

        const filter = { Lead_Owner: { $exists: true, $ne: null, $ne: '' } };

        if (req.query.status) {
            filter.Status = buildStatusRegex(req.query.status);
        }

        const agents = await collection.distinct('Lead_Owner', filter);

        res.json({ success: true, data: agents.filter(Boolean).sort() });
    } catch (error) {
        console.error('Error fetching agents:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch agents.' });
    }
});

// GET /api/leads/debug – shows all distinct Status values + counts
app.get('/api/leads/debug', async (req, res) => {
    try {
        const database = await connectDB();
        const collection = database.collection('leads_master');

        const [statusAgg, total, sample] = await Promise.all([
            collection.aggregate([
                { $group: { _id: '$Status', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]).toArray(),
            collection.countDocuments(),
            collection.findOne(),
        ]);

        res.json({
            success: true,
            totalDocuments: total,
            statusBreakdown: statusAgg.map((s) => ({ status: s._id, count: s.count })),
            sampleFieldNames: sample ? Object.keys(sample) : [],
        });
    } catch (error) {
        console.error('Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Call prompt routing ───────────────────────────────────────────────────────

const STAGE_AGENT_MAP = {
    fresh: process.env.FRESH_CALL_AGENT_ID || process.env.AGENT_ID,
    mql: process.env.MQL_CALL_AGENT_ID || process.env.AGENT_ID,
    sql: process.env.SQL_CALL_AGENT_ID || process.env.AGENT_ID,
    followup: process.env.FOLLOWUP_CALL_AGENT_ID || process.env.AGENT_ID,
};

function resolveCallType(status) {
    if (!status) return 'fresh';
    const s = status.toLowerCase().replace(/[\s_\-/]+/g, '');
    if (s === 'srfmql' || s === 'mql') return 'mql';
    if (s === 'sql') return 'sql';
    if (s.startsWith('follow')) return 'followup';
    return 'fresh';
}

/**
 * Select the correct agent ID based on lead status.
 * Maps: "Follow Up" → FOLLOWUP_AGENT_ID, "SRF/MQL" → MQL_AGENT_ID,
 *        "SQL" → MQL_AGENT_ID, else → FRESH_AGENT_ID
 */
function getAgentIdByStatus(status) {
    if (!status) return STAGE_AGENT_MAP.fresh;
    const s = status.toLowerCase().replace(/[\s_\-/]+/g, '');
    if (s.startsWith('follow')) return STAGE_AGENT_MAP.followup;
    if (s === 'srfmql' || s === 'mql') return STAGE_AGENT_MAP.mql;
    if (s === 'sql') return STAGE_AGENT_MAP.sql;
    return STAGE_AGENT_MAP.fresh;
}

function resolveAgentId(callType, clientAgentId) {
    return STAGE_AGENT_MAP[callType] || clientAgentId || process.env.AGENT_ID;
}

function buildLeadContext(lead) {
    return {
        company_name: lead.Client_Company_Name || '',
        contact_name: lead.Client_Person_Name || '',
        phone_number: lead.Client_Number || '',
        email: lead.Client_Mail_ID || '',
        product: lead.Product || '',
        location: lead.Location || '',
        quantity: lead.Quantity ?? '',
        industry: lead.Industry || '',
        lead_type: lead.Lead_Type || '',
        remarks: lead.Remarks || '',
        lead_owner: lead.Lead_Owner || '',
        enquiry_code: lead['Enquiry Code'] || '',
        status: lead.Status || '',
    };
}

function normalizePhone(raw) {
    let phone = String(raw).replace(/[\s\-()]/g, '');
    if (/^\d{10}$/.test(phone)) phone = '+91' + phone;
    else if (/^91\d{10}$/.test(phone)) phone = '+' + phone;
    return phone;
}

// ── Call endpoints ────────────────────────────────────────────────────────────

app.post('/api/call', async (req, res) => {
    let { recipient_phone_number, lead_data, section_name } = req.body;

    if (!recipient_phone_number) {
        return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    recipient_phone_number = normalizePhone(recipient_phone_number);

    try {
        const database = await connectDB();
        const collection = database.collection('leads_master');

        // Step 1: Fetch the real lead from MongoDB for accurate status + fields
        const enquiryCode = lead_data?.enquiry_code || null;
        let dbLead = null;
        if (enquiryCode) {
            dbLead = await collection.findOne({ 'Enquiry Code': enquiryCode });
        }

        // Step 2: Determine call type & agent from the DB lead's actual Status
        const leadStatus = dbLead?.Status || lead_data?.status || '';
        const callType = resolveCallType(leadStatus);
        const agent_id = getAgentIdByStatus(leadStatus);

        if (!agent_id) {
            return res.status(400).json({ success: false, error: 'No agent ID resolved for this call type.' });
        }

        // Step 3: Build enriched context from DB lead (falls back to client data)
        const leadContext = dbLead ? buildLeadContext(dbLead) : (lead_data || {});

        // Step 4: Build Bolna payload with CRM variables injected via user_data
        // These variables are referenced in the agent prompt as {name}, {company_name}, etc.
        const bolnaPayload = {
            agent_id,
            recipient_phone_number,
            user_data: {
                // Primary CRM variables the agent prompt references
                name: leadContext.contact_name || '',
                company_name: leadContext.company_name || '',
                product: leadContext.product || '',
                location: leadContext.location || '',
                remarks: leadContext.remarks || '',
                quantity: leadContext.quantity || '',
                // Additional context
                call_type: callType,
                enquiry_code: leadContext.enquiry_code || '',
                lead_context: leadContext,
            },
        };

        console.log(`\n=== INITIATING CALL ===`);
        console.log(`Section:   ${section_name || 'unknown'}`);
        console.log(`Call Type: ${callType.toUpperCase()}`);
        console.log(`Agent:     ${agent_id}`);
        console.log(`Phone:     ${recipient_phone_number}`);
        console.log(`Lead:      ${leadContext.enquiry_code} – ${leadContext.company_name}`);
        console.log(`Status:    ${leadStatus}`);
        console.log(`Variables: name=${leadContext.contact_name}, company_name=${leadContext.company_name}, product=${leadContext.product}, location=${leadContext.location}`);
        console.log(`Remarks:   ${leadContext.remarks}`);
        console.log(`========================\n`);

        const response = await fetch(BOLNA_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(bolnaPayload),
        });

        let data;
        const rawText = await response.text();
        try {
            data = JSON.parse(rawText);
        } catch {
            console.error('Bolna returned non-JSON:', rawText);
            data = { message: rawText || 'Bolna returned an invalid response' };
        }

        try {
            await database.collection('call_logs').insertOne({
                call_time: new Date(),
                lead_enquiry_code: enquiryCode,
                agent_id,
                call_type: callType,
                section_name: section_name || null,
                recipient_phone: recipient_phone_number,
                lead_context: leadContext,
                variables_sent: bolnaPayload.user_data,
                call_status: response.ok ? 'initiated' : 'failed',
                bolna_response: data,
            });
        } catch (logErr) {
            console.error('Failed to write call log:', logErr.message);
        }

        if (!response.ok) {
            console.error('Bolna API Error:', data);
            return res.status(response.status).json({ success: false, error: data.message || 'Call failed' });
        }

        res.json({
            success: true,
            message: 'Call initiated successfully!',
            call_type: callType,
            agent_id,
            execution_id: data.execution_id || data.id || null,
            data,
        });
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error while reaching Bolna.' });
    }
});

// ── Get execution details (transcript) from Bolna ────────────────────────────

app.get('/api/execution/:executionId', async (req, res) => {
    const { executionId } = req.params;

    if (!executionId) {
        return res.status(400).json({ success: false, error: 'execution ID is required.' });
    }

    try {
        const response = await fetch(`https://api.bolna.dev/v2/executions/${executionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        let data;
        const rawText = await response.text();
        try {
            data = JSON.parse(rawText);
        } catch {
            console.error('Bolna execution detail returned non-JSON:', rawText.substring(0, 300));
            data = { message: rawText || 'Invalid response' };
        }

        if (!response.ok) {
            return res.status(response.status).json({ success: false, error: data.message || 'Failed to fetch execution' });
        }

        res.json({ success: true, data });
    } catch (error) {
        console.error('Execution fetch error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch execution details.' });
    }
});

// ── Call Complete: Retrieve transcript → Store follow-up → Extract → Update ──

app.post('/api/call/complete', async (req, res) => {
    const { enquiry_code, execution_id } = req.body;

    if (!enquiry_code) {
        return res.status(400).json({ success: false, error: 'enquiry_code is required.' });
    }

    try {
        const database = await connectDB();
        const collection = database.collection('leads_master');

        // Fetch the lead for status and context
        const lead = await collection.findOne({ 'Enquiry Code': enquiry_code });
        if (!lead) {
            return res.status(404).json({ success: false, error: 'Lead not found.' });
        }

        const leadStatus = lead.Status || '';
        const stage = resolveCallType(leadStatus);

        // Step 1: Retrieve transcript from Bolna if execution_id is provided
        let transcript = '';
        let extractedData = null;
        let bolnaExecution = null;

        if (execution_id) {
            try {
                const execResponse = await fetch(`https://api.bolna.dev/v2/executions/${execution_id}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${BOLNA_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                });

                if (execResponse.ok) {
                    const rawText = await execResponse.text();
                    try {
                        bolnaExecution = JSON.parse(rawText);
                    } catch {
                        console.error('Bolna execution parse error.');
                    }

                    if (bolnaExecution) {
                        // Extract transcript - Bolna stores it in various fields
                        transcript = bolnaExecution.transcript
                            || bolnaExecution.conversation_transcript
                            || '';

                        // If transcript is an array of messages, join them
                        if (Array.isArray(transcript)) {
                            transcript = transcript
                                .map(msg => `${msg.role || msg.speaker || 'unknown'}: ${msg.content || msg.text || ''}`)
                                .join('\n');
                        }

                        // Extract any extracted_data from Bolna
                        extractedData = bolnaExecution.extracted_data || null;
                    }
                }
            } catch (execErr) {
                console.error('Failed to fetch Bolna execution:', execErr.message);
            }
        }

        // Step 2: Generate a summary from the transcript
        const transcriptSummary = transcript
            ? transcript.substring(0, 500).replace(/\n/g, ' ').trim()
            : 'AI call completed – no transcript available';

        // Step 3: Store transcript as a follow-up entry
        const followUpEntry = {
            date: new Date(),
            remark: transcriptSummary,
            source: 'ai_call_agent',
            stage: stage || leadStatus || 'Follow Up',
            transcript: transcript || '',
        };

        await collection.updateOne(
            { 'Enquiry Code': enquiry_code },
            {
                $push: {
                    'follow_up_control.entries': followUpEntry,
                },
            },
        );

        console.log(`[Call Complete] ${enquiry_code}: follow-up entry stored with transcript (${transcript.length} chars)`);

        // Step 4: AI extraction from transcript – detect updated info
        let aiExtracted = {};

        if (transcript && transcript.length > 50) {
            aiExtracted = extractInfoFromTranscript(transcript);
        }

        // Merge Bolna's extracted_data if available
        if (extractedData && typeof extractedData === 'object') {
            aiExtracted = { ...aiExtracted, ...extractedData };
        }

        // Step 5: Update MongoDB lead with any new extracted values
        const fieldMap = {
            product: 'Product',
            quantity: 'Quantity',
            location: 'Location',
            timeline: 'Timeline',
            interest: 'Interest_Level',
            next_followup_date: 'Follow_Up_Date_1',
            objection: 'Objection',
        };

        const $set = {};
        for (const [extractKey, dbField] of Object.entries(fieldMap)) {
            const val = aiExtracted[extractKey];
            if (val !== undefined && val !== null && val !== '') {
                $set[dbField] = val;
            }
        }

        if (Object.keys($set).length > 0) {
            await collection.updateOne(
                { 'Enquiry Code': enquiry_code },
                { $set },
            );
            console.log(`[AI Extract] ${enquiry_code}: updated fields - ${Object.keys($set).join(', ')}`);
        }

        // Step 6: Fetch the updated lead to return to the frontend
        const updatedLead = await collection.findOne({ 'Enquiry Code': enquiry_code });

        res.json({
            success: true,
            message: 'Call completed. Transcript stored and lead updated.',
            follow_up_entry: followUpEntry,
            ai_extracted: aiExtracted,
            fields_updated: Object.keys($set),
            updated_lead: updatedLead,
        });
    } catch (error) {
        console.error('Call complete error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Simple rule-based extraction from transcript text.
 * Looks for common keywords to detect product, quantity, location, timeline, interest.
 */
function extractInfoFromTranscript(transcript) {
    const extracted = {};
    const text = transcript.toLowerCase();

    // Quantity extraction – look for number patterns near 'container', 'unit', 'piece'
    const qtyMatch = text.match(/(\d+)\s*(container|unit|piece|nos|no\.?s)/i);
    if (qtyMatch) {
        extracted.quantity = parseInt(qtyMatch[1], 10);
    }

    // Location extraction – look for "in <city>" or "at <city>" or "for <city>"
    const locMatch = text.match(/(?:in|at|for|to)\s+([a-z]+(?:\s[a-z]+)?)\s*(?:port|city|area|location)?/i);
    if (locMatch && locMatch[1].length > 2 && locMatch[1].length < 30) {
        // Capitalize first letter
        extracted.location = locMatch[1].charAt(0).toUpperCase() + locMatch[1].slice(1);
    }

    // Timeline extraction – look for "within X days/months" or "by <month>"
    const timeMatch = text.match(/(?:within|in|by|before)\s+(\d+\s*(?:day|week|month|year)s?)/i)
        || text.match(/(?:within|in|by|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i);
    if (timeMatch) {
        extracted.timeline = timeMatch[0].trim();
    }

    // Interest level detection
    if (text.includes('confirm') || text.includes('interested') || text.includes('serious') || text.includes('definitely')) {
        extracted.interest = 'serious';
    } else if (text.includes('thinking') || text.includes('considering') || text.includes('maybe')) {
        extracted.interest = 'moderate';
    } else if (text.includes('not interested') || text.includes('no need') || text.includes('cancel')) {
        extracted.interest = 'low';
    }

    return extracted;
}

// ── AI Webhook: update lead with extracted data ──────────────────────────────

app.post('/api/leads/update-from-ai', async (req, res) => {
    try {
        const { enquiry_code, ...fields } = req.body;

        if (!enquiry_code) {
            return res.status(400).json({ success: false, error: 'enquiry_code is required.' });
        }

        const fieldMap = {
            company_name: 'Client_Company_Name',
            contact_name: 'Client_Person_Name',
            phone: 'Client_Number',
            email: 'Client_Mail_ID',
            product: 'Product',
            location: 'Location',
            lead_type: 'Lead_Type',
            industry: 'Industry',
            quantity: 'Quantity',
        };

        const $set = {};
        for (const [aiKey, dbField] of Object.entries(fieldMap)) {
            if (fields[aiKey] !== undefined && fields[aiKey] !== null && fields[aiKey] !== '') {
                $set[dbField] = fields[aiKey];
            }
        }

        if (Object.keys($set).length === 0) {
            return res.json({ success: true, message: 'No fields to update.' });
        }

        const database = await connectDB();
        const result = await database.collection('leads_master').updateOne(
            { 'Enquiry Code': enquiry_code },
            { $set },
        );

        console.log(`[AI Update] ${enquiry_code}: updated ${Object.keys($set).length} fields`);
        res.json({ success: true, matched: result.matchedCount, modified: result.modifiedCount });
    } catch (error) {
        console.error('AI update error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── AI Webhook: add follow-up remark after a call ────────────────────────────

app.post('/api/leads/add-followup', async (req, res) => {
    try {
        const { enquiry_code, call_summary, stage, transcript } = req.body;

        if (!enquiry_code) {
            return res.status(400).json({ success: false, error: 'enquiry_code is required.' });
        }

        const database = await connectDB();
        const result = await database.collection('leads_master').updateOne(
            { 'Enquiry Code': enquiry_code },
            {
                $push: {
                    'follow_up_control.entries': {
                        date: new Date(),
                        remark: call_summary || '',
                        source: 'ai_call_agent',
                        stage: stage || null,
                        transcript: transcript || '',
                    },
                },
            },
        );

        console.log(`[AI Follow-up] ${enquiry_code}: remark added`);
        res.json({ success: true, matched: result.matchedCount, modified: result.modifiedCount });
    } catch (error) {
        console.error('Follow-up error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Get single lead with follow-up entries ───────────────────────────────────

app.get('/api/leads/:enquiryCode', async (req, res) => {
    try {
        const database = await connectDB();
        const lead = await database.collection('leads_master').findOne({
            'Enquiry Code': req.params.enquiryCode,
        });

        if (!lead) {
            return res.status(404).json({ success: false, error: 'Lead not found.' });
        }

        res.json({ success: true, data: lead });
    } catch (error) {
        console.error('Lead fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Bolna executions ─────────────────────────────────────────────────────────

const COST_KEYS = new Set(['cost', 'total_cost', 'avgCost', 'callCost', 'totalCost']);

function stripCostFromObject(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(stripCostFromObject);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (COST_KEYS.has(k)) continue;
        out[k] = stripCostFromObject(v);
    }
    return out;
}

app.get('/api/executions', async (req, res) => {
    const agent_id = req.query.agent_id || process.env.AGENT_ID;

    if (!agent_id) {
        return res.status(400).json({ success: false, error: 'Agent ID is required (set AGENT_ID in .env or pass it).' });
    }

    try {
        const response = await fetch(`https://api.bolna.dev/v2/agent/${agent_id}/executions`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${BOLNA_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        let data;
        const rawText = await response.text();
        try {
            data = JSON.parse(rawText);
        } catch {
            console.error('Bolna executions returned non-JSON:', rawText.substring(0, 200));
            data = { message: rawText || 'Bolna returned an invalid response' };
        }

        console.log(`\n=== BOLNA API RAW DATA (Agent: ${agent_id}) ===`);
        console.log(JSON.stringify(data, null, 2).substring(0, 2000));
        console.log(`=============================================\n`);

        if (!response.ok) {
            console.error('Bolna API Error:', data);
            return res.status(response.status).json({ success: false, error: data.message || 'Failed to fetch executions' });
        }

        res.json({ success: true, data: stripCostFromObject(data) });
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error while fetching from Bolna.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
