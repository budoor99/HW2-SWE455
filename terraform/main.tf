terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ── Enable required GCP APIs ──────────────────────────────────────────────────
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "apigateway.googleapis.com",
    "servicemanagement.googleapis.com",
    "servicecontrol.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ── Service Account ───────────────────────────────────────────────────────────
resource "google_service_account" "maas_sa" {
  account_id   = "maas-service-account"
  display_name = "MaaS Service Account"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.maas_sa.email}"
}

resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.maas_sa.email}"
}

# ── Pub/Sub Topic — Event Bridge ──────────────────────────────────────────────
resource "google_pubsub_topic" "pi_topic" {
  name                       = "pi-estimation-topic"
  message_retention_duration = "86400s"
  depends_on                 = [google_project_service.services]
}

# ── Firestore — External Data Store ──────────────────────────────────────────
resource "google_firestore_database" "maas_db" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.services]
}

# ── Cloud Run: Simulator — Service 2 ─────────────────────────────────────────
resource "google_cloud_run_v2_service" "simulator" {
  name     = "maas-simulator"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.maas_sa.email

    # 1 request per instance so Cloud Run scales out for concurrent jobs
    # 50 concurrent jobs = Cloud Run spins up 50 instances automatically
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 64
    }

    containers {
      image = var.simulator_image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle = false
      }

      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "COLLECTION_NAME"
        value = "pi-results"
      }
    }

    timeout = "600s"
  }

  depends_on = [
    google_project_service.services,
    google_firestore_database.maas_db,
  ]
}

# Allow Pub/Sub to invoke the Simulator
resource "google_cloud_run_service_iam_member" "pubsub_invoke_simulator" {
  location = google_cloud_run_v2_service.simulator.location
  service  = google_cloud_run_v2_service.simulator.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.maas_sa.email}"
}

# ── Pub/Sub Subscription — pushes events to Simulator ────────────────────────
resource "google_pubsub_subscription" "pi_subscription" {
  name  = "pi-estimation-subscription"
  topic = google_pubsub_topic.pi_topic.name

  push_config {
    push_endpoint = google_cloud_run_v2_service.simulator.uri
    oidc_token {
      service_account_email = google_service_account.maas_sa.email
    }
  }

  ack_deadline_seconds       = 600
  message_retention_duration = "86400s"

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  depends_on = [google_cloud_run_service_iam_member.pubsub_invoke_simulator]
}

# ── Cloud Run: Receiver — Service 1 ──────────────────────────────────────────
resource "google_cloud_run_v2_service" "receiver" {
  name     = "maas-receiver"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.maas_sa.email

    scaling {
      min_instance_count = 1
      max_instance_count = 20
    }

    containers {
      image = var.receiver_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "TOPIC_ID"
        value = google_pubsub_topic.pi_topic.name
      }
      env {
        name  = "COLLECTION_NAME"
        value = "pi-results"
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_pubsub_topic.pi_topic,
  ]
}

# Allow unauthenticated public access to Receiver
resource "google_cloud_run_service_iam_member" "receiver_public" {
  location = google_cloud_run_v2_service.receiver.location
  service  = google_cloud_run_v2_service.receiver.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── API Gateway ───────────────────────────────────────────────────────────────
resource "google_api_gateway_api" "maas_api" {
  provider   = google-beta
  api_id     = "maas-api"
  depends_on = [google_project_service.services]
}

resource "google_api_gateway_api_config" "maas_config" {
  provider      = google-beta
  api           = google_api_gateway_api.maas_api.api_id
  api_config_id = "maas-config-v4"

  openapi_documents {
    document {
      path     = "openapi.yaml"
      contents = base64encode(replace(
        file("${path.module}/openapi.yaml"),
        "RECEIVER_CLOUD_RUN_URL",
        google_cloud_run_v2_service.receiver.uri
      ))
    }
  }

  lifecycle { create_before_destroy = true }
  depends_on = [google_cloud_run_v2_service.receiver]
}

resource "google_api_gateway_gateway" "maas_gateway" {
  provider   = google-beta
  api_config = google_api_gateway_api_config.maas_config.id
  gateway_id = "maas-gateway"
  region     = var.region
  depends_on = [google_api_gateway_api_config.maas_config]
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "api_gateway_url" {
  description = "Public endpoint — use this for all API calls"
  value       = "https://${google_api_gateway_gateway.maas_gateway.default_hostname}"
}

output "receiver_url" {
  description = "Receiver Cloud Run URL"
  value       = google_cloud_run_v2_service.receiver.uri
}

output "simulator_url" {
  description = "Simulator Cloud Run URL (internal)"
  value       = google_cloud_run_v2_service.simulator.uri
}

output "pubsub_topic" {
  description = "Pub/Sub topic name"
  value       = google_pubsub_topic.pi_topic.name
}

output "firestore_db" {
  description = "Firestore database name"
  value       = google_firestore_database.maas_db.name
}
