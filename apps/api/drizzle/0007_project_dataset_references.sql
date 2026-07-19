CREATE TABLE "project_dataset_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_registry" varchar(32) NOT NULL,
	"dataset_id" varchar(255) NOT NULL,
	"dataset_url" varchar(512) NOT NULL,
	"dataset_name" varchar(255) NOT NULL,
	"license" varchar(128),
	"task_type" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"creation_event_hash" varchar(64) NOT NULL,
	"removal_event_hash" varchar(64)
);
--> statement-breakpoint
ALTER TABLE "project_dataset_references" ADD CONSTRAINT "project_dataset_references_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_dataset_refs_project_idx" ON "project_dataset_references" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_dataset_refs_project_active_idx" ON "project_dataset_references" USING btree ("project_id","removed_at");
