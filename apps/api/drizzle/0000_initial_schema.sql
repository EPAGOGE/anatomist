CREATE TYPE "public"."event_type" AS ENUM('user-generated', 'synthetic-derived', 'system-operational', 'validation-attestation');--> statement-breakpoint
CREATE TYPE "public"."node_role" AS ENUM('node', 'supernode', 'investigator', 'tower');--> statement-breakpoint
CREATE TABLE "chain_heads" (
	"chain_id" varchar(64) NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"head_hash" varchar(64) NOT NULL,
	"head_sequence_marker" bigint NOT NULL,
	"event_count" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_heads_chain_id_source_id_pk" PRIMARY KEY("chain_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "event_absence_entries" (
	"event_hash" varchar(64) NOT NULL,
	"ordinal" integer NOT NULL,
	"expected_hash" varchar(64) NOT NULL,
	"window_start" bigint NOT NULL,
	"window_end" bigint NOT NULL,
	CONSTRAINT "event_absence_entries_event_hash_ordinal_pk" PRIMARY KEY("event_hash","ordinal")
);
--> statement-breakpoint
CREATE TABLE "event_predecessors" (
	"event_hash" varchar(64) NOT NULL,
	"ordinal" integer NOT NULL,
	"predecessor_hash" varchar(64) NOT NULL,
	CONSTRAINT "event_predecessors_event_hash_ordinal_pk" PRIMARY KEY("event_hash","ordinal")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_hash" varchar(64) PRIMARY KEY NOT NULL,
	"chain_id" varchar(64) NOT NULL,
	"event_type" "event_type" NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"causal_sequence_marker" bigint NOT NULL,
	"source_reliability" integer NOT NULL,
	"payload_integrity" varchar(64) NOT NULL,
	"signature_pq" "bytea" NOT NULL,
	"signature_classical" "bytea" NOT NULL,
	"ground_truth_calibration_indicator" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"role" "node_role" NOT NULL,
	"attestation_public_key_pq" "bytea" NOT NULL,
	"attestation_public_key_classical" "bytea" NOT NULL,
	CONSTRAINT "users_source_id_unique" UNIQUE("source_id")
);
--> statement-breakpoint
ALTER TABLE "event_absence_entries" ADD CONSTRAINT "event_absence_entries_event_hash_events_event_hash_fk" FOREIGN KEY ("event_hash") REFERENCES "public"."events"("event_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_predecessors" ADD CONSTRAINT "event_predecessors_event_hash_events_event_hash_fk" FOREIGN KEY ("event_hash") REFERENCES "public"."events"("event_hash") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_predecessors_predecessor_idx" ON "event_predecessors" USING btree ("predecessor_hash");--> statement-breakpoint
CREATE INDEX "events_chain_marker_idx" ON "events" USING btree ("chain_id","causal_sequence_marker");--> statement-breakpoint
CREATE INDEX "events_source_marker_idx" ON "events" USING btree ("chain_id","source_id","causal_sequence_marker");