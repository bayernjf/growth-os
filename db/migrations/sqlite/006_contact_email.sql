-- 006_contact_email.sql (sqlite dialect)
-- growth-os G5 matching: contact email on buyer demands and supplier offers
-- so a match can be routed into the outreach (email) flow.

ALTER TABLE buyer_demands ADD COLUMN email TEXT;
ALTER TABLE supplier_offers ADD COLUMN email TEXT;
