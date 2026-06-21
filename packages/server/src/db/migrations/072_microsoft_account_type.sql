-- Microsoft accounts carry an extra account_type ('msa' personal vs 'entra'
-- work/school) that Google has no equivalent for. Added separately from 071 so
-- both fresh installs (071 created the table without it) and the dev DB (071
-- already ran) converge on the same shape.
ALTER TABLE microsoft_accounts ADD COLUMN account_type TEXT;
