#!/usr/bin/env bash
export REGION='us-east-1'

get_repo_link() {
    repository_exists=$(aws ecr-public describe-repositories --repository-names $1 --region ${REGION} --query 'repositories[0].repositoryUri' --output text 2>&1)
    if [[ $? -eq 0 ]]; then
        # Repository exists, extract the repositoryUri
        repositoryUri=$repository_exists
        echo $repositoryUri
    else
        # Repository doesn't exist, create it and extract the repositoryUri
        output=$(aws ecr-public create-repository --repository-name $1 --region ${REGION} --no-cli-pager)
        repositoryUri=$(echo $output | jq -r '.repository.repositoryUri')
        echo $repositoryUri
    fi
}

aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws

repo_uri=$(get_repo_link nodejs-http)
echo "REPO is" ${repo_uri}

docker build -t nodejs-http .
docker tag nodejs-http:latest ${repo_uri}:latest
docker push ${repo_uri}:latest

