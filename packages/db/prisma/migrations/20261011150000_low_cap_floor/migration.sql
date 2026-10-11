-- Balanced vaults still on the old $500M default move to the new $1M floor (owner decision).
UPDATE "Strategy" SET "minMcap" = 1 WHERE "profile" = 'balanced' AND "minMcap" = 500;
