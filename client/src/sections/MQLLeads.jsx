import LeadSection from '../components/LeadSection';

export default function MQLLeads() {
  return (
    <LeadSection
      status="SRF/MQL"
      sectionName="MQL Leads"
      agentId="30625f51-f66e-40c9-9d58-bfab7674c93c"
      title="Marketing Qualified Leads"
      description="Leads that have interacted with the system and require qualification. Filtered from leads_master where status = 'SRF/MQL'."
      emptyMessage="No MQL leads found."
    />
  );
}
