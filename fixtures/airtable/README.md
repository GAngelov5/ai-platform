# Synthetic Airtable test base ("Sales CRM")

Three small tables for trying the Airtable source by hand
([MANUAL-TESTING.md §15](../../docs/MANUAL-TESTING.md)). Every company,
person, e-mail address and phone number here is made up; the domains are
`.example`.

| File | Table | Primary field | Rows |
|---|---|---|---|
| `Customers.csv` | Customers | Name | 4 |
| `Deals.csv` | Deals | Deal | 4 |
| `Contacts.csv` | Contacts | Full name | 4 |

## Import

1. In Airtable: **Create → Start from scratch** (or **Import → CSV file**).
   Name the base **Sales CRM**, and import `Customers.csv`. The first
   column becomes the primary field.
2. In the same base, **+ Add or import → CSV file** for `Deals.csv`, then
   again for `Contacts.csv`.
3. Make the links real, so the source can resolve them:
   - In **Deals**, change the field type of **Customer** to **Link to
     another record → Customers**. Airtable matches the names it already
     holds.
   - In **Contacts**, do the same for **Customer**.
4. In **Deals**, change **Signed** to **Checkbox** ("checked" becomes a
   tick), **Amount (EUR)** to **Currency**, and **Close date** to **Date**.
5. Optional: add an **Attachment** field to Deals with any small file. The
   record then shows `Contract: <file name>`; the file itself is never
   downloaded.

## What to expect after Sync now

- 12 documents in Admin → Sources → `airtable`, one per record, titled by
  the primary field.
- For example, "Northwind 2027 renewal" contains:

  ```
  Customer: Northwind Logistics
  Amount (EUR): 48000
  Stage: Negotiation
  Close date: 2027-03-15
  Notes: Discount capped at 8% by finance.
  ```

Questions to ask the Knowledge Assistant:

- "What is the discount cap for the Northwind renewal?" (cites the deal)
- "Who is the training coordinator at Tailspin Travel?" (cites the contact)
- "Which customers does Maria Petrova own?" (cites two customers)
