FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /workspace
COPY server/jvm-weekly-api/pom.xml ./pom.xml

COPY server/jvm-weekly-api/src ./src
RUN for attempt in 1 2 3; do \
      mvn -q -DskipTests package && exit 0; \
      echo "maven package failed on attempt ${attempt}; retrying"; \
      sleep $((attempt * 5)); \
    done; \
    exit 1

FROM eclipse-temurin:21-jre

WORKDIR /app
ENV WEEKLY_API_PORT=8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=50.0 -XX:+ExitOnOutOfMemoryError"

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app

COPY --from=build /workspace/target/jvm-weekly-api-0.1.0-SNAPSHOT.jar /app/jvm-weekly-api.jar

EXPOSE 8080
USER app
ENTRYPOINT ["java", "-jar", "/app/jvm-weekly-api.jar"]
