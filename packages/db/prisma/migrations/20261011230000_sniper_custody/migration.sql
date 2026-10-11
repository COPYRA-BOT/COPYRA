-- Independent sniper custody wallet (Solana keypair, separate from copy SOL).
-- Does not alter existing SOLANA/EVM custody rows or copy-trade formulas.

ALTER TYPE "CustodyFamily" ADD VALUE IF NOT EXISTS 'SNIPER';
