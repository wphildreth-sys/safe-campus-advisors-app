# Safe Campus Advisors LLC - School Safety Audit Platform

## Setup
1. Copy `.env.example` to `.env`
2. Add your Supabase values
3. Run:

```bash
npm install
npm run dev
```

## Required Supabase resources
- Run `supabase_schema.sql`
- Create storage bucket: `assessment-files`
- Enable Email, Google, and Azure providers in Supabase Auth
