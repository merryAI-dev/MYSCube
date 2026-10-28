package dev.merryai.innerplatform.weekly;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.ToolProvider;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

class JvmContainerMemoryPolicyTest {
    @TempDir Path temporary;

    @Test
    void bothImagesGiveTheHeapHalfOfTheExisting512MiBudget() throws Exception {
        for (String dockerfile : List.of("Dockerfile", "Dockerfile.runtime")) {
            List<String> options = runtimeOptions(dockerfile);
            List<String> args = new ArrayList<>(options);
            args.addAll(List.of("-XX:MaxRAM=512m", "-XX:+PrintFlagsFinal", "-version"));
            Result result = run(args);
            assertThat(result.exitCode()).isZero();
            var heap = Pattern.compile("\\bMaxHeapSize\\s+=\\s+(\\d+)").matcher(result.output());
            assertThat(heap.find()).isTrue();
            assertThat(Long.parseLong(heap.group(1))).isBetween(240L * 1024 * 1024, 256L * 1024 * 1024);
            assertThat(result.output()).containsPattern("ExitOnOutOfMemoryError\\s+=\\s+true");
        }
    }

    @Test
    void heapExhaustionTerminatesInsteadOfLeavingACaughtErrorInALiveProcess() throws Exception {
        Path source = temporary.resolve("ExhaustHeap.java");
        Files.writeString(source, """
            public class ExhaustHeap {
                public static void main(String[] args) {
                    try { System.out.println(new byte[64 * 1024 * 1024].length); }
                    catch (OutOfMemoryError error) { System.out.println("OOM_WAS_CAUGHT"); }
                }
            }
            """);
        assertThat(ToolProvider.getSystemJavaCompiler().run(null, null, null, source.toString())).isZero();
        for (String dockerfile : List.of("Dockerfile", "Dockerfile.runtime")) {
            List<String> args = new ArrayList<>(runtimeOptions(dockerfile));
            args.addAll(List.of("-Xmx16m", "-cp", temporary.toString(), "ExhaustHeap"));
            Result result = run(args);
            assertThat(result.exitCode()).isNotZero();
            assertThat(result.output()).contains("Terminating due to java.lang.OutOfMemoryError");
            assertThat(result.output()).doesNotContain("OOM_WAS_CAUGHT");
        }
    }

    private List<String> runtimeOptions(String dockerfile) throws Exception {
        String content = Files.readString(Path.of(dockerfile));
        var options = Pattern.compile("(?m)^ENV JAVA_TOOL_OPTIONS=\"([^\"]+)\"$").matcher(content);
        assertThat(options.find()).as(dockerfile + " runtime memory options").isTrue();
        return List.of(options.group(1).split("\\s+"));
    }

    private Result run(List<String> arguments) throws Exception {
        List<String> command = new ArrayList<>();
        command.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
        command.addAll(arguments);
        Path output = Files.createTempFile(temporary, "jvm-", ".log");
        ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().remove("JAVA_TOOL_OPTIONS");
        Process process = builder.start();
        if (!process.waitFor(20, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            throw new AssertionError("JVM did not finish within 20 seconds");
        }
        return new Result(process.exitValue(), Files.readString(output));
    }

    private record Result(int exitCode, String output) {}
}
