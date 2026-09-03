import { App as TaskClient } from "@pideck/tasks-client/client"
import "@pideck/tasks-client/styles.css"
import { BrowserRouter } from "react-router-dom"

export default function TaskSurface() {
  return (
    <BrowserRouter>
      <TaskClient />
    </BrowserRouter>
  )
}
