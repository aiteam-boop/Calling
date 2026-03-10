import LeadSection from '../components/LeadSection';

export default function SQLLeads() {
  return (
    <LeadSection
      status="SQL"
      sectionName="SQL Leads"
      agentId="30625f51-f66e-40c9-9d58-bfab7674c93c"
      title="Sales Qualified Leads"
      description="Leads that are ready for sales discussion or deal closing. Filtered from leads_master where status = 'SQL'."
      emptyMessage="No SQL leads found."
    />
  );
}
