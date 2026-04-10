variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "receiver_image" {
  description = "Artifact Registry image URI for the Receiver service"
  type        = string
}

variable "simulator_image" {
  description = "Artifact Registry image URI for the Simulator service"
  type        = string
}
