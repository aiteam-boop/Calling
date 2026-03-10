const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function insertTestLead() {
    const client = new MongoClient(process.env.MONGODB_URI);
    try {
        await client.connect();
        console.log('✅ Connected to MongoDB');

        const db = client.db();
        const collection = db.collection('leads_master');

        // Remove any previous test entry first (idempotent)
        await collection.deleteOne({ 'Enquiry Code': 'EQTESTFOLLOW001' });
        console.log('🗑️  Removed existing test lead (if any)');

        const now = new Date();

        const result = await collection.insertOne({
            'Enquiry Code': 'EQTESTFOLLOW001',
            Date: now,
            Lead_Owner: 'Dhiksha',
            Lead_Source: 'Test',
            Client_Company_Name: 'Test Logistics Pvt Ltd',
            Industry: 'Logistics',
            Client_Person_Name: 'Dhiksha Chavan',
            Client_Number: '7977485841',
            Client_Mail_ID: 'testlead@test.com',
            Product: 'Dry Container',
            Size: '40 FT',
            Location: 'Mumbai',
            Status: 'Follow Up',
            Lead_Type: 'Sale',
            Quantity: 1,
            Remarks:
                'Client interested in purchasing one 40ft used dry container for storage purpose in Mumbai. Asked to follow up regarding final decision.',
            Follow_Up_Date: now,
            Follow_Up_Remarks:
                'Client interested but evaluating budget. Requested follow-up call.',
            Expected_Closure: null,
            Client_Budget_Lead_Value: null,
            Sales_Owner: 'Dhiksha',
            follow_up_control: {
                entries: [
                    {
                        date: now,
                        remark: 'Initial follow-up test entry for AI call testing.',
                        source: 'dashboard',
                        stage: 'Follow Up',
                        createdBy: 'Dhiksha',
                    },
                ],
                status: 'Follow Up',
            },
            synced_at: now,
        });

        console.log('\n✅ Test lead inserted successfully!');
        console.log('   Inserted ID :', result.insertedId);
        console.log('   Enquiry Code: EQTESTFOLLOW001');
        console.log('   Lead Owner  : Dhiksha');
        console.log('   Phone       : 7977485841');
        console.log('   Status      : Follow Up');
        console.log('\n👉 Now go to the Follow-ups section in the dashboard,');
        console.log('   filter by Agent Owner → Dhiksha, and click Call.');
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        await client.close();
        console.log('\nMongoDB connection closed.');
    }
}

insertTestLead();
