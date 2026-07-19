CREATE TABLE "chain_owners" (
	"chain_id" varchar(64) PRIMARY KEY NOT NULL,
	"owner_type" varchar(32) NOT NULL,
	"owner_entity_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
