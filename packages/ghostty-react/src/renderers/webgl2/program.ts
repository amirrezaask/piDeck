export class WebGlProgramError extends Error {
  readonly name = "WebGlProgramError";

  constructor(
    readonly stage: "vertex" | "fragment" | "link" | "self-test",
    message: string,
  ) {
    super(message);
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  stage: "vertex" | "fragment",
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new WebGlProgramError(stage, "WebGL could not allocate a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "shader compilation failed";
    gl.deleteShader(shader);
    throw new WebGlProgramError(stage, message);
  }
  return shader;
}

export function createWebGlProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, "vertex");
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, "fragment");
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new WebGlProgramError("link", "WebGL could not allocate a program");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "program link failed";
    gl.deleteProgram(program);
    throw new WebGlProgramError("link", message);
  }
  return program;
}

export function assertWebGlSelfTest(gl: WebGL2RenderingContext): void {
  const vertex = `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fragment = `#version 300 es
    precision mediump float;
    out vec4 outColor;
    void main() { outColor = vec4(1.0, 0.0, 1.0, 1.0); }`;
  const program = createWebGlProgram(gl, vertex, fragment);
  gl.useProgram(program);
  gl.viewport(0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const error = gl.getError();
  gl.deleteProgram(program);
  if (error !== gl.NO_ERROR) {
    throw new WebGlProgramError("self-test", `WebGL self-test failed with error ${error}`);
  }
}
