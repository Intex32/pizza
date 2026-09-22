docker buildx build --platform linux/arm64 -t pizza-night:arm64 --load .
docker image inspect pizza-night:arm64 --format '{{.Architecture}}'
docker save pizza-night:arm64 -o pizza-night-arm64.tar
scp pizza-night-arm64.tar muon:~/pizza