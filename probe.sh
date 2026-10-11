echo "=== uname ==="; uname -a
echo "=== docker ==="; docker -v; docker compose version
echo "=== port 8350/3000 ==="; ss -tlnp 2>/dev/null | grep -E ':8350|:3000' || echo "8350 and 3000 are FREE"
echo "=== df /vol2 ==="; df -h /vol2 2>/dev/null
echo "=== /vol2/1000/docker ==="; ls /vol2/1000/docker 2>/dev/null
echo "=== node image present? ==="; docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'node:20' || echo "no node:20 image yet"
