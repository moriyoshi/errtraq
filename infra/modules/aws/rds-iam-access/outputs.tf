output "policies" {
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary; One database user and the same scoped IAM connect grant for each capability."
  value = {
    read   = { primary = local.connect_policy }
    write  = { primary = local.connect_policy }
    delete = { primary = local.connect_policy }
  }
}
