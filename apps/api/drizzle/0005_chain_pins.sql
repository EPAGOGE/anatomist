CREATE TABLE "chain_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" varchar(64) NOT NULL,
	"event_hash" varchar(64) NOT NULL,
	"label" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_pins" ADD CONSTRAINT "chain_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_pins_user_chain_event_unique" ON "chain_pins" USING btree ("user_id","chain_id","event_hash");--> statement-breakpoint
CREATE INDEX "chain_pins_user_idx" ON "chain_pins" USING btree ("user_id","chain_id");