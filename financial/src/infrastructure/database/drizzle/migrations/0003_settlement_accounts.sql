-- Where the cash of a settlement moved, so Treasury can record it in that account. It lives
-- in another context, so it is a reference, never a foreign key (ADR 0041).
ALTER TABLE "title_settlements" ADD COLUMN "treasury_account_id" uuid;
