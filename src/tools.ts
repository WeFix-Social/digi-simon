// const url = "http://localhost:5173/api/anspruchEinfach";

const url = "https://kindergeld.plus/api/anspruchEinfach";
export async function anspruch(input: any) {
  console.log("Anspruch: input=", input);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  console.log("Anspruch: response=", data);

  return JSON.stringify(data);
}
