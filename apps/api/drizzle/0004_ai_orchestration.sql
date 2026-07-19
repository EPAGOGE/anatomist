CREATE TABLE "ai_budgets" (
	"user_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"monthly_cap_nanos" bigint NOT NULL,
	"warn_at_pct" integer DEFAULT 80 NOT NULL,
	"spent_nanos" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"source_id" varchar(255) NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"project_id" uuid,
	"feature" varchar(128),
	"model" varchar(64) NOT NULL,
	"tier" varchar(16) NOT NULL,
	"cache_hit_local" boolean DEFAULT false NOT NULL,
	"cache_hit_prompt" boolean DEFAULT false NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_input_nanos" bigint NOT NULL,
	"cost_output_nanos" bigint NOT NULL,
	"cost_cache_read_nanos" bigint NOT NULL,
	"cost_cache_write_nanos" bigint NOT NULL,
	"cost_total_nanos" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"finish_reason" varchar(32),
	"request_id" varchar(128),
	"prompt_hash" varchar(64) NOT NULL,
	"response_hash" varchar(64) NOT NULL,
	"system_prompt_id" varchar(128),
	"context_selection_json" text,
	"chain_event_hash" varchar(64),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_response_cache" (
	"cache_key" varchar(64) PRIMARY KEY NOT NULL,
	"model" varchar(64) NOT NULL,
	"response_text" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_hit_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_budgets" ADD CONSTRAINT "ai_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_budgets_pk" ON "ai_budgets" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "ai_interactions_user_idx" ON "ai_interactions" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_interactions_purpose_idx" ON "ai_interactions" USING btree ("purpose","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_interactions_project_idx" ON "ai_interactions" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_interactions_model_idx" ON "ai_interactions" USING btree ("model","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_response_cache_expiry_idx" ON "ai_response_cache" USING btree ("expires_at");