// First agent (Phase 4). Running in shadow via flows/enquiry-responder-shadow.js: drafts only.
// Goes live only after Jake's yes in docs/CHECKIN.md; until then every write is shadowed and
// there is no email connector, so nothing can leave DS Flow.
export default {
  id: 'enquiry-responder',
  name: 'Enquiry responder',
  job: 'Reply to each website enquiry with a short note offering the intro chat, and record the lead in DSOS.',
  actions: {
    // Create the lead in DSOS. Needs Jake's yes each time once writes go live.
    'dsos:POST /api/v1/leads': 'approval',
    // Send the reply. No email connector exists yet; listed so the permission is on record.
    'email:SEND *': 'approval',
  },
};
