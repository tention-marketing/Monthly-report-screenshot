# Product Specification

## Product

Tention Monthly Performance Report Extension is an internal reporting system intended to support more than 100 client accounts. Data correctness takes priority over presentation and automation.

## V1 shape

V1 consists of a Chrome extension, including a full-page extension dashboard, plus a backend. It does not include a separate conventional website.

The users are assumed to be the Tention internal team for now. **PENDING OWNER CONFIRMATION.**

## Primary workflow

```text
Open extension
  -> choose client
  -> choose completed calendar month
  -> validate data
  -> follow screenshot checklist
  -> approve captures
  -> preview
  -> generate PDF
```

V1 will eventually support client and month selection, capture and cropping, capture approval, a completion checklist, preview, PDF generation, history, an editable next-month plan, deterministic Top 5 Campaigns, and deterministic Top 5 Flows.

## System ownership

The extension is the team interface. The backend owns secrets, provider access, deterministic calculations, validation, report state, storage, history, narrative orchestration, and final rendering. Numeric report values come from validated structured data. Screenshots provide visual evidence.

## Non-goals for V1

- A public website or client portal
- Fully autonomous Klaviyo navigation
- Brittle automation for every provider page
- Automatic report delivery to every client
- Batch screenshot capture
- One custom template per client
- Financial calculation by AI or screenshot OCR
- Rebuilding verified integrations without evidence

Authentication, provider integrations, financial metrics, screenshot capture, PDF generation, persistence, and batch processing are outside Phase 1A.
